import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
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
import { credentialService } from '../src/modules/auth';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import { workOrderService } from '../src/modules/work-orders';
import {
  createAdminUser,
  createSessionWithPermissions,
  createSessionWithPermissionsForUser,
} from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2E — Work Order classification
 * finalization.
 *
 * The business rule this suite locks in:
 *   - Customer Care may raise a Service Request with NO technical trade; the
 *     trade is Operations' decision on the Work Order.
 *   - A Handyman-lifecycle Work Order (Customer Care origin) must be classified
 *     before a NEW assignment. An unclassified job is NOT an unrestricted job:
 *     the competency gate may never report a verdict it could not compute.
 *   - GENERAL_REPAIR is chosen by Operations for generic repairs; nothing
 *     classifies a Work Order automatically.
 *   - Workers stay multi-skill: a certificate/trade never restricts which job a
 *     person may take, and only MANDATORY requirements block.
 *   - Changing the classification while an assignment is ACTIVE is allowed and
 *     SAFE: the same evaluator revalidates the running assignment inside the
 *     same transaction, refuses the change when a MANDATORY gap would open, and
 *     otherwise appends a RECLASSIFIED decision to the ledger.
 *   - Work Orders from other domains (no Customer Care binding) keep their
 *     pre-03B2E behaviour, and historical assignments stay readable.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let embedded: EmbeddedTestDatabase | null = null;
let adminToken = '';
let adminUserId = '';

const EMBEDDED_DIR = '/tmp/hm-classification-03b2e-pg';
const EMBEDDED_PORT = 55666;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

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
  // The cluster is created fresh, so no TRUNCATE is needed — and a
  // `TRUNCATE users CASCADE` would purge the platform-level trade registry
  // seeded by migration 0465.

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
    name: 'Classification Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PR_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BL_${suffix()}`,
    name: 'Building',
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

/** A Handyman-managed field worker (03B2D: permanent/contract/freelance). */
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
 * The same Direct Workforce worker, but with a real login bound to the profile:
 * field execution (acknowledge / start / evidence / complete) authorizes the
 * CALLER against the ACTIVE assignment's `workforce_profiles.user_id`, so a
 * worker-path test needs a session for that user, not an administrator.
 */
async function workerWithSession(r: Realm) {
  const user = await userService.createUser({
    email: `field-${suffix().toLowerCase()}@example.com`,
    displayName: `Field Worker ${suffix()}`,
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
    fullName: 'Field Worker',
    workforceType: 'FREELANCE',
    userId: user.id,
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: r.building.id,
  });
  // BE-02G: the SESSION's Building access comes from the user-level assignment,
  // not from the workforce placement (which is what the assignment authority
  // validates separately).
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: r.building.id,
  });
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

/**
 * A Work Order that belongs to the Handyman lifecycle: Customer Care raises a
 * free-text Service Request (NO technical trade, NO service catalog), converts
 * it to a work request and then to a Work Order.
 */
async function customerCareWorkOrder(
  r: Realm,
  requestType = 'KERAN_BOCOR',
): Promise<string> {
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
    .post(`/api/v1/clients/${r.client.id}/tenant-companies`)
    .set(auth())
    .send({ tenantCode: `TN_${suffix()}`, tenantName: 'Tenant Co' });
  assert.equal(company.status, 201, JSON.stringify(company.body));

  const pic = await api()
    .post(`/api/v1/tenant-companies/${company.body.data.id}/pics`)
    .set(auth())
    .send({ picName: 'Tenant PIC', email: `pic-${suffix().toLowerCase()}@tenant.example.com` });
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
      // Deliberately free text: Customer Care does not pick a technical trade.
      requestType,
      title: 'Wastafel bocor di kamar mandi',
      description: 'Air menetes dari pipa bawah wastafel sejak pagi.',
      priority: 'HIGH',
    });
  assert.equal(request.status, 201, JSON.stringify(request.body));

  const workRequest = await api()
    .post(`/api/v1/tenant-service-requests/${request.body.data.id}/work-request`)
    .set(auth());
  assert.equal(workRequest.status, 201, JSON.stringify(workRequest.body));

  const workOrder = await api()
    .post(`/api/v1/tenant-service-requests/${request.body.data.id}/work-order`)
    .set(auth())
    .send({ workOrderNumber: `WO_${suffix()}` });
  assert.equal(workOrder.status, 201, JSON.stringify(workOrder.body));
  return workOrder.body.data.workOrderId as string;
}

/** A Work Order with no Customer Care origin (classification stays optional). */
async function directWorkOrder(r: Realm) {
  return workOrderService.createWorkOrder({
    clientId: r.client.id,
    buildingId: r.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Preventive maintenance job',
    description: 'Raised directly by Engineering, not by Customer Care.',
    workType: 'PREVENTIVE',
    createdByUserId: adminUserId,
  });
}

async function tradeCategoryId(code: string): Promise<string> {
  const result = await q(
    'SELECT id FROM work_order_trade_categories WHERE code = $1',
    [code],
  );
  assert.ok(result.rows[0], `seeded trade category ${code} is missing`);
  return result.rows[0].id as string;
}

function classify(workOrderId: string, body: Record<string, unknown>) {
  return api()
    .patch(`/api/v1/work-orders/${workOrderId}/classification`)
    .set(auth())
    .send(body);
}

function readClassification(workOrderId: string) {
  return api()
    .get(`/api/v1/work-orders/${workOrderId}/classification`)
    .set(auth());
}

function assign(workOrderId: string, body: Record<string, unknown>) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/assignments`)
    .set(auth())
    .send(body);
}

function reassign(
  workOrderId: string,
  assignmentId: string,
  body: Record<string, unknown>,
) {
  return api()
    .patch(`/api/v1/work-orders/${workOrderId}/assignments/${assignmentId}`)
    .set(auth())
    .send(body);
}

function addRequirement(
  categoryId: string,
  clientId: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(
      `/api/v1/work-order-trade-categories/${categoryId}/competency-requirements?clientId=${clientId}`,
    )
    .set(auth())
    .send(body);
}

async function decisionRows(workOrderId: string) {
  const result = await q(
    `SELECT action, assignment_id, workforce_profile_id, trade_category_code,
            enforcement_level, satisfied, reason
       FROM work_order_assignment_competency_decisions
      WHERE work_order_id = $1
      ORDER BY evaluated_at ASC, id ASC`,
    [workOrderId],
  );
  return result.rows as Array<{
    action: string;
    assignment_id: string;
    workforce_profile_id: string;
    trade_category_code: string | null;
    enforcement_level: string;
    satisfied: boolean;
    reason: string | null;
  }>;
}

async function assignmentRows(workOrderId: string) {
  const result = await q(
    `SELECT id, assignee_type, workforce_profile_id, status
       FROM work_order_assignments
      WHERE work_order_id = $1
      ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows as Array<{
    id: string;
    assignee_type: string;
    workforce_profile_id: string | null;
    status: string;
  }>;
}

async function classificationRow(workOrderId: string) {
  const result = await q(
    `SELECT trade_category_id, trade_category_code, risk_level
       FROM work_orders WHERE id = $1`,
    [workOrderId],
  );
  return result.rows[0] as {
    trade_category_id: string | null;
    trade_category_code: string | null;
    risk_level: string | null;
  };
}

// ---------------------------------------------------------------------------
// E1 — Customer Care intake and the classification the gate needs
// ---------------------------------------------------------------------------

describe('PART 03B2E-E1 — classification is Operations’ decision, not intake', () => {
  it('accepts a free-text Customer Care request and creates an unclassified Work Order', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const woId = await customerCareWorkOrder(r, 'KERAN_WASTAFEL_BOCOR');

    const classification = await readClassification(woId);
    assert.equal(classification.status, 200, JSON.stringify(classification.body));
    assert.equal(classification.body.data.tradeCategoryId, null);
    assert.equal(
      classification.body.data.classificationRequired,
      true,
      'a Customer Care Work Order must declare that its classification is owed',
    );

    const row = await classificationRow(woId);
    assert.equal(row.trade_category_id, null);
    // Customer Care's free text becomes the Work Order type — it is intake
    // vocabulary, never a trade decision.
    const stored = await q('SELECT work_type FROM work_orders WHERE id = $1', [woId]);
    assert.equal(stored.rows[0].work_type, 'KERAN_WASTAFEL_BOCOR');
  });

  it('refuses a NEW assignment while the Work Order is unclassified', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const woId = await customerCareWorkOrder(r);
    const w = await worker(r);

    const response = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WORK_ORDER_CLASSIFICATION_REQUIRED',
      'an unclassified job must never slide through the competency gate',
    );

    // The refusal writes nothing at all.
    assert.deepEqual(await assignmentRows(woId), []);
    assert.deepEqual(await decisionRows(woId), []);
  });

  it('refuses a REASSIGNMENT while the Work Order is unclassified', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const woId = await customerCareWorkOrder(r);
    const first = await worker(r);
    const second = await worker(r);

    // Assign under a real classification, then clear it while the assignment
    // is running: clearing is refused, so this state can never be reached
    // through the API. Simulate the historical/unreachable state directly to
    // prove the reassignment guard also fails closed.
    const plumbing = await tradeCategoryId('PLUMBING');
    assert.equal((await classify(woId, { tradeCategoryId: plumbing })).status, 200);
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: first.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    await q(
      `UPDATE work_orders
          SET trade_category_id = NULL, trade_category_code = NULL,
              risk_level = NULL, classified_at = NULL,
              classified_by_user_id = NULL
        WHERE id = $1`,
      [woId],
    );

    const response = await reassign(woId, assigned.body.data.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: second.id,
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'WORK_ORDER_CLASSIFICATION_REQUIRED',
    );
    const rows = await assignmentRows(woId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ACTIVE');
    assert.equal(rows[0].workforce_profile_id, first.id);
  });

  it('lets Operations classify a generic repair as GENERAL_REPAIR — never automatically', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const woId = await customerCareWorkOrder(r);
    const w = await worker(r);

    // Nothing classified the job on its own.
    assert.equal((await classificationRow(woId)).trade_category_id, null);

    const generalRepair = await tradeCategoryId('GENERAL_REPAIR');
    const classified = await classify(woId, { tradeCategoryId: generalRepair });
    assert.equal(classified.status, 200, JSON.stringify(classified.body));
    assert.equal(classified.body.data.tradeCategoryCode, 'GENERAL_REPAIR');

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    const rows = await decisionRows(woId);
    assert.equal(rows.length, 0, 'GENERAL_REPAIR has no configured requirement');
    const row = await classificationRow(woId);
    assert.equal(row.trade_category_code, 'GENERAL_REPAIR');
  });
});

// ---------------------------------------------------------------------------
// E2 — multi-skill and direct (freelance) workforce stay untouched
// ---------------------------------------------------------------------------

describe('PART 03B2E-E2 — the gate keeps the 03B2B/03B2D business rules', () => {
  it('lets an AC-certified worker take a plumbing job (no restriction by certificate trade)', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const plumbing = await tradeCategoryId('PLUMBING');

    const plumbingSkill = await skillService.createSkill({
      clientId: r.client.id,
      code: `PLUMB_${suffix()}`,
      name: 'Plumbing Repair',
      category: 'TECHNICAL',
    });
    const created = await addRequirement(plumbing, r.client.id, {
      requirementType: 'SKILL',
      enforcementLevel: 'MANDATORY',
      skillId: plumbingSkill.id,
      minimumProficiencyLevel: 'BASIC',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // The worker's identity is an AC technician (its first skill), yet it also
    // holds the plumbing skill — nothing may derive "allowed trades" from
    // certificates or from the first skill.
    const acSkill = await skillService.createSkill({
      clientId: r.client.id,
      code: `AC_${suffix()}`,
      name: 'AC Service',
      category: 'TECHNICAL',
    });
    const w = await worker(r, 'CONTRACT');
    await assignSkillToWorkforce({
      workforceProfileId: w.id,
      skillId: acSkill.id,
      proficiencyLevel: 'EXPERT',
    });
    await assignSkillToWorkforce({
      workforceProfileId: w.id,
      skillId: plumbingSkill.id,
      proficiencyLevel: 'INTERMEDIATE',
    });

    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: plumbing });
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const rows = await decisionRows(woId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].satisfied, true);
  });

  it('warns (never blocks) for an unmet RECOMMENDED requirement', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const electrical = await tradeCategoryId('ELECTRICAL_MINOR');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `ELEC_${suffix()}`,
      name: 'Minor Electrical',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(electrical, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'RECOMMENDED',
          skillId: skill.id,
          minimumProficiencyLevel: 'ADVANCED',
        })
      ).status,
      201,
    );

    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: electrical });

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.competency.satisfied, true);
    const advisory = assigned.body.data.competency.advisory;
    assert.equal(advisory.length, 1);
    assert.equal(advisory[0].workforceProfileId, w.id);
    assert.equal(advisory[0].requirementType, 'SKILL');
    assert.equal(advisory[0].reason, 'SKILL_MISSING');
  });

  it('assigns a FREELANCE worker of the direct workforce (03B2D) through the same gate', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const sanitary = await tradeCategoryId('SANITARY');
    const w = await worker(r, 'FREELANCE');

    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: sanitary });

    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.data.workforceProfileId, w.id);

    const stored = await q(
      'SELECT workforce_type FROM workforce_profiles WHERE id = $1',
      [w.id],
    );
    assert.equal(stored.rows[0].workforce_type, 'FREELANCE');
  });
});

// ---------------------------------------------------------------------------
// E3 — classification change against an ACTIVE assignment
// ---------------------------------------------------------------------------

describe('PART 03B2E-E3 — reclassification with a running assignment', () => {
  it('refuses a classification change that would leave the assignee below MANDATORY', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const electrical = await tradeCategoryId('ELECTRICAL_MINOR');

    const certSkill = await skillService.createSkill({
      clientId: r.client.id,
      code: `K3_${suffix()}`,
      name: 'K3 Electrical Safety',
      category: 'SAFETY',
    });
    assert.equal(
      (
        await addRequirement(electrical, r.client.id, {
          requirementType: 'CERTIFICATION',
          enforcementLevel: 'MANDATORY',
          skillId: certSkill.id,
          certificateName: 'K3 Listrik',
        })
      ).status,
      201,
    );

    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: painting });
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const before = await decisionRows(woId);

    const refused = await classify(woId, { tradeCategoryId: electrical });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.code,
      'WORK_ORDER_CLASSIFICATION_CONFLICT',
      'a running job must not be silently invalidated by a new trade',
    );
    assert.ok(Array.isArray(refused.body.error.details));
    assert.ok(refused.body.error.details.length > 0);

    // Nothing moved: the classification, the assignment and the ledger are
    // exactly as they were.
    const row = await classificationRow(woId);
    assert.equal(row.trade_category_code, 'PAINTING');
    const assignments = await assignmentRows(woId);
    assert.equal(assignments.filter((a) => a.status === 'ACTIVE').length, 1);
    assert.equal(assignments[0].id, assigned.body.data.id);
    assert.deepEqual(await decisionRows(woId), before);
  });

  it('revalidates and records RECLASSIFIED when the assignee still satisfies the new trade', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const sanitary = await tradeCategoryId('SANITARY');

    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SAN_${suffix()}`,
      name: 'Sanitary Fitting',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(sanitary, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'MANDATORY',
          skillId: skill.id,
          minimumProficiencyLevel: 'BASIC',
        })
      ).status,
      201,
    );

    const w = await worker(r);
    await assignSkillToWorkforce({
      workforceProfileId: w.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });

    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: painting });
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    const reclassified = await classify(woId, { tradeCategoryId: sanitary });
    assert.equal(reclassified.status, 200, JSON.stringify(reclassified.body));
    assert.equal(reclassified.body.data.tradeCategoryCode, 'SANITARY');

    // The assignment itself is untouched (same row, still ACTIVE) — the trade
    // changed, not the person doing the job.
    const assignments = await assignmentRows(woId);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].id, assigned.body.data.id);
    assert.equal(assignments[0].status, 'ACTIVE');

    // The ledger explains the running assignment under the NEW trade.
    const rows = await decisionRows(woId);
    const reclassifiedRows = rows.filter((row) => row.action === 'RECLASSIFIED');
    assert.equal(reclassifiedRows.length, 1);
    assert.equal(reclassifiedRows[0].assignment_id, assigned.body.data.id);
    assert.equal(reclassifiedRows[0].trade_category_code, 'SANITARY');
    assert.equal(reclassifiedRows[0].satisfied, true);

    // Audit trail proves the revalidation ran.
    const events = await q(
      `SELECT metadata FROM operational_events
        WHERE entity_type = 'WORK_ORDER' AND entity_id = $1
          AND event_type = 'WORK_ORDER_CLASSIFIED'
        ORDER BY occurred_at ASC, id ASC`,
      [woId],
    );
    const metadata = events.rows[events.rowCount! - 1].metadata as {
      previousTradeCategoryId: string | null;
      revalidation: { assignmentId: string; satisfied: boolean } | null;
    };
    assert.equal(metadata.previousTradeCategoryId, painting);
    assert.equal(metadata.revalidation?.assignmentId, assigned.body.data.id);
    assert.equal(metadata.revalidation?.satisfied, true);
  });

  it('records a RECOMMENDED gap as a warning during reclassification', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const furniture = await tradeCategoryId('FURNITURE');

    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `FURN_${suffix()}`,
      name: 'Furniture Assembly',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(furniture, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'RECOMMENDED',
          skillId: skill.id,
          minimumProficiencyLevel: 'EXPERT',
        })
      ).status,
      201,
    );

    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: painting });
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    const reclassified = await classify(woId, { tradeCategoryId: furniture });
    assert.equal(reclassified.status, 200, JSON.stringify(reclassified.body));

    const rows = await decisionRows(woId);
    const advisory = rows.filter((row) => row.action === 'RECLASSIFIED');
    assert.equal(advisory.length, 1);
    assert.equal(advisory[0].enforcement_level, 'RECOMMENDED');
    assert.equal(advisory[0].satisfied, false);
    assert.equal(advisory[0].reason, 'SKILL_MISSING');
  });

  it('refuses to CLEAR the classification of an assigned Customer Care Work Order', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: painting });
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    const cleared = await classify(woId, { tradeCategoryId: null });
    assert.equal(cleared.status, 409, JSON.stringify(cleared.body));
    assert.equal(cleared.body.error.code, 'WORK_ORDER_CLASSIFICATION_CONFLICT');
    assert.equal((await classificationRow(woId)).trade_category_code, 'PAINTING');
    assert.equal((await assignmentRows(woId))[0].status, 'ACTIVE');
  });

  it('revalidates nothing when no assignment is ACTIVE', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const sanitary = await tradeCategoryId('SANITARY');
    const woId = await customerCareWorkOrder(r);

    assert.equal((await classify(woId, { tradeCategoryId: painting })).status, 200);
    const changed = await classify(woId, { tradeCategoryId: sanitary });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(await decisionRows(woId), []);

    // Clearing is allowed again once nothing is assigned.
    const cleared = await classify(woId, { tradeCategoryId: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.data.tradeCategoryId, null);
  });
});

// ---------------------------------------------------------------------------
// E4 — compatibility with everything that is NOT a Customer Care Work Order
// ---------------------------------------------------------------------------

describe('PART 03B2E-E4 — compatibility', () => {
  it('keeps classification optional for a Work Order with no Customer Care origin', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const wo = await directWorkOrder(r);
    const w = await worker(r);

    const classification = await readClassification(wo.id);
    assert.equal(classification.body.data.classificationRequired, false);

    const assigned = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(
      assigned.status,
      201,
      'non-Customer-Care Work Orders keep their pre-03B2E behaviour',
    );
  });

  it('leaves an already assigned historical Work Order readable and explainable', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const plumbing = await tradeCategoryId('PLUMBING');
    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: plumbing, riskLevel: 'HIGH' });
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: w.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    // Re-saving the SAME classification is a no-op for the ledger.
    const same = await classify(woId, { tradeCategoryId: plumbing, riskLevel: 'HIGH' });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal((await decisionRows(woId)).length, 0);

    const current = await api()
      .get(`/api/v1/work-orders/${woId}/assignments/current`)
      .set(auth());
    assert.equal(current.status, 200);
    assert.equal(current.body.data.id, assigned.body.data.id);

    const ledger = await api()
      .get(`/api/v1/work-orders/${woId}/assignments/competency-decisions`)
      .set(auth());
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
  });

  it('rejects an unknown ledger action filter instead of silently returning nothing', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const wo = await directWorkOrder(r);
    const response = await api()
      .get(`/api/v1/work-orders/${wo.id}/assignments/competency-decisions?action=BOGUS`)
      .set(auth());
    assert.equal(response.status, 400, JSON.stringify(response.body));
  });

  it('keeps executing a legacy assigned Work Order that predates the rule', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const plumbing = await tradeCategoryId('PLUMBING');
    const { profile, token } = await workerWithSession(r);
    const woId = await customerCareWorkOrder(r);
    assert.equal((await classify(woId, { tradeCategoryId: plumbing })).status, 200);
    const assigned = await assign(woId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: profile.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    // A Work Order assigned BEFORE this PART: the assignment exists but the
    // classification does not. The new rule must not retroactively break work
    // that is already running — it only governs NEW assignment decisions.
    await q(
      `UPDATE work_orders
          SET trade_category_id = NULL, trade_category_code = NULL,
              risk_level = NULL, classified_at = NULL,
              classified_by_user_id = NULL
        WHERE id = $1`,
      [woId],
    );

    const workerAuth = { Authorization: `Bearer ${token}` };

    // A new decision on the same Work Order is still refused...
    const next = await worker(r);
    const refusedReassign = await reassign(woId, assigned.body.data.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: next.id,
    });
    assert.equal(refusedReassign.status, 409, JSON.stringify(refusedReassign.body));
    assert.equal(
      refusedReassign.body.error.code,
      'WORK_ORDER_CLASSIFICATION_REQUIRED',
    );

    // ...while the running job stays fully executable end to end.
    const acknowledged = await api()
      .post(`/api/v1/work-orders/${woId}/acknowledge`)
      .set(workerAuth)
      .send({});
    assert.equal(acknowledged.status, 201, JSON.stringify(acknowledged.body));

    const started = await api()
      .post(`/api/v1/work-orders/${woId}/start`)
      .set(workerAuth)
      .send({});
    assert.equal(started.status, 201, JSON.stringify(started.body));

    const evidence = await api()
      .post(`/api/v1/work-orders/${woId}/evidence`)
      .set(workerAuth)
      .send({
        evidenceType: 'PHOTO',
        fileReference: `field/legacy-${suffix()}.jpg`,
        originalFileName: 'before.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
      });
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));

    const completed = await api()
      .post(`/api/v1/work-orders/${woId}/complete`)
      .set(workerAuth)
      .send({ completionSummary: 'Legacy job finished.', completionNotes: 'No defect.' });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));

    const stored = await q('SELECT status FROM work_orders WHERE id = $1', [woId]);
    assert.equal(stored.rows[0].status, 'COMPLETED');
  });

  it('accepts the RECLASSIFIED action filter', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const sanitary = await tradeCategoryId('SANITARY');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SANF_${suffix()}`,
      name: 'Sanitary Fitting',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(sanitary, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'RECOMMENDED',
          skillId: skill.id,
          minimumProficiencyLevel: 'BASIC',
        })
      ).status,
      201,
    );
    const w = await worker(r);
    const woId = await customerCareWorkOrder(r);
    await classify(woId, { tradeCategoryId: painting });
    await assign(woId, { assigneeType: 'WORKFORCE', workforceProfileId: w.id });
    assert.equal((await classify(woId, { tradeCategoryId: sanitary })).status, 200);

    const filtered = await api()
      .get(
        `/api/v1/work-orders/${woId}/assignments/competency-decisions?action=RECLASSIFIED`,
      )
      .set(auth());
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].action, 'RECLASSIFIED');
  });
});

// ---------------------------------------------------------------------------
// E5 — authorization and Building scope are unchanged by this PART
// ---------------------------------------------------------------------------

describe('PART 03B2E-E5 — authorization', () => {
  it('denies classification and assignment outside the caller’s Building scope', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const woId = await customerCareWorkOrder(r);
    const w = await worker(r);

    // A role that carries the right permission codes but is not assigned to the
    // Work Order's Building: a broad permission must never widen scope.
    const outsider = await createSessionWithPermissions([
      { code: 'work_order.read', name: 'Read Work Orders' },
      { code: 'work_order.manage', name: 'Manage Work Orders' },
    ]);

    const deniedClassify = await api()
      .patch(`/api/v1/work-orders/${woId}/classification`)
      .set({ Authorization: `Bearer ${outsider}` })
      .send({ tradeCategoryId: painting });
    assert.equal(deniedClassify.status, 403, JSON.stringify(deniedClassify.body));
    assert.equal((await classificationRow(woId)).trade_category_id, null);

    const deniedAssign = await api()
      .post(`/api/v1/work-orders/${woId}/assignments`)
      .set({ Authorization: `Bearer ${outsider}` })
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: w.id });
    assert.equal(deniedAssign.status, 403, JSON.stringify(deniedAssign.body));
    assert.deepEqual(await assignmentRows(woId), []);
  });

  it('requires `work_order.manage` to classify, even with read access', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const painting = await tradeCategoryId('PAINTING');
    const woId = await customerCareWorkOrder(r);

    const reader = await createSessionWithPermissions([
      { code: 'work_order.read', name: 'Read Work Orders' },
    ]);
    const denied = await api()
      .patch(`/api/v1/work-orders/${woId}/classification`)
      .set({ Authorization: `Bearer ${reader}` })
      .send({ tradeCategoryId: painting });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal((await classificationRow(woId)).trade_category_id, null);
  });
});
