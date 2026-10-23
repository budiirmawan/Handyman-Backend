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
import { teamService } from '../src/modules/teams';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { assignSkillToWorkforce } from '../src/modules/workforce-skills';
import { workforceCertificationService } from '../src/modules/workforce-certifications';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import {
  startEmbeddedTestDatabase,
  type EmbeddedTestDatabase,
} from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — multi-trade Work Order.
 *
 * The business correction this suite locks in: Handyman is a MULTI-TRADE
 * light-repair platform (AC, plumbing, minor electrical, sanitary, door/lock,
 * furniture, painting, ceiling, tiling, installation, generic repair) — never
 * an AC-only service, and never a Service-Catalog-only flow.
 *
 * Coverage map to the CR requirements:
 *   1/2  Customer Care Service Request → Work Order → Assignment runs on a
 *        FREE-TEXT request type with no Service Catalog (T14).
 *   3/5  The Work Order's authoritative trade classification (set by
 *        Operations) maps to skill/certificate needs (T2, T3).
 *   4    The trade registry is data, not an AC enum (T1).
 *   6    The PART 03A evaluator is reused for assign AND reassign, including a
 *        multi-worker team (T3, T8, T10).
 *   7/8  Certificates are required only when configured; an unconfigured trade
 *        is assignable (T6, T7, T13).
 *   9    Nothing makes certification globally mandatory (T6, T7).
 *   10   Every existing assignment path is gated without a parallel workflow
 *        (WORKFORCE / TEAM / VENDOR / VENDOR_WORKFORCE: T3, T8, T9).
 *   11   Client/Building isolation, RBAC, the decision ledger and transaction
 *        rollback are preserved (T10, T11, T12, T15, T16).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let embedded: EmbeddedTestDatabase | null = null;
let adminToken = '';
let adminUserId = '';

const EMBEDDED_DIR = '/tmp/hm-multitrade-03b2a-pg';
const EMBEDDED_PORT = 55662;

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

const FUTURE_DATE = '2030-12-31T00:00:00.000Z';
const ISSUE_DATE = '2025-01-01T00:00:00.000Z';

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
  // The embedded cluster is created fresh for this run (startEmbeddedTestDatabase
  // removes the data directory), so no TRUNCATE is needed. That matters: a
  // `TRUNCATE users CASCADE` would also purge the platform-level trade registry
  // seeded by migration 0465 (its created_by_user_id references users).

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

async function realm(assignTo: string | null = adminUserId): Promise<Realm> {
  const client = await clientService.createClient({
    code: `CL_${suffix()}`,
    name: 'Multi-trade Client',
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
  if (assignTo) {
    await buildingAssignmentService.createAssignment(assignTo, {
      buildingId: building.id,
    });
  }
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `OR_${suffix()}`,
    name: 'Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DP_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `PS_${suffix()}`,
    name: 'Position',
  });
  return { client, building, organization, department, position };
}

async function worker(
  r: Realm,
  options: { teamId?: string; type?: 'INTERNAL' | 'EXTERNAL' } = {},
) {
  const profile = await workforceService.createWorkforceProfile({
    organizationId: r.organization.id,
    departmentId: r.department.id,
    positionId: r.position.id,
    ...(options.teamId ? { teamId: options.teamId } : {}),
    employeeCode: `WF_${suffix()}`,
    fullName: `Worker ${suffix()}`,
    workforceType: options.type ?? 'INTERNAL',
  });
  // Every Work Order assignee must be placed in the Work Order's Building
  // (BE-08E rule, unchanged by this PART).
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: r.building.id,
  });
  return profile;
}

async function workOrder(r: Realm, workType = 'PLUMBING_LEAK') {
  return workOrderService.createWorkOrder({
    clientId: r.client.id,
    buildingId: r.building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Multi-trade job',
    description: 'Leaking sink in the tenant unit.',
    workType,
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

async function classify(
  workOrderId: string,
  body: Record<string, unknown>,
  token = adminToken,
) {
  return api()
    .patch(`/api/v1/work-orders/${workOrderId}/classification`)
    .set(auth(token))
    .send(body);
}

async function assign(workOrderId: string, body: Record<string, unknown>, token = adminToken) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/assignments`)
    .set(auth(token))
    .send(body);
}

async function addRequirement(
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
    `SELECT action, assignee_type, workforce_profile_id, requirement_id,
            requirement_type, enforcement_level, satisfied, reason,
            evidence_proficiency_level, evidence_certification_id,
            evidence_verification_status, trade_category_code, risk_level
       FROM work_order_assignment_competency_decisions
      WHERE work_order_id = $1
      ORDER BY evaluated_at ASC, id ASC`,
    [workOrderId],
  );
  return result.rows;
}

async function assignmentRows(workOrderId: string) {
  const result = await q(
    `SELECT id, assignee_type, workforce_profile_id, status
       FROM work_order_assignments
      WHERE work_order_id = $1
      ORDER BY created_at ASC`,
    [workOrderId],
  );
  return result.rows;
}

const certificationActor = (userId: string, permissions: string[]) => ({
  id: userId,
  permissions: new Set(permissions),
});

const CERT_ACTOR_PERMISSIONS = [
  'workforce_certification.read',
  'workforce_certification.manage',
  'workforce_certification.verify',
];

async function giveCertificate(
  r: Realm,
  workforceProfileId: string,
  options: {
    skillId?: string;
    certificateName: string;
    verify?: boolean;
    expired?: boolean;
  },
): Promise<string> {
  const created = await workforceCertificationService.createWorkforceCertification(
    workforceProfileId,
    {
      ...(options.skillId ? { skillId: options.skillId } : {}),
      certificateNumber: `CERT-${suffix()}`,
      certificateName: options.certificateName,
      issuingAuthority: 'Kementerian Ketenagakerjaan RI',
      issueDate: ISSUE_DATE,
      expiryDate: FUTURE_DATE,
    },
    certificationActor(adminUserId, CERT_ACTOR_PERMISSIONS),
  );
  if (options.verify) {
    await workforceCertificationService.verifyWorkforceCertification(
      workforceProfileId,
      created.id,
      { verificationStatus: 'VERIFIED' },
      certificationActor(adminUserId, CERT_ACTOR_PERMISSIONS),
    );
  }
  if (options.expired) {
    // A verified attestation whose validity window has already closed — the
    // state the evaluator must read as CERTIFICATION_EXPIRED.
    await q(
      `UPDATE workforce_certifications
          SET status = 'EXPIRED'
        WHERE id = $1`,
      [created.id],
    );
    await q(
      `UPDATE workforce_certifications
          SET issue_date = '2018-01-01T00:00:00.000Z',
              expiry_date = '2021-01-01T00:00:00.000Z',
              verification_status = 'VERIFIED'
        WHERE id = $1`,
      [created.id],
    );
  }
  assert.ok(r.client.id);
  return created.id;
}

// ---------------------------------------------------------------------------
// T1 — the configurable multi-trade registry
// ---------------------------------------------------------------------------

describe('PART 03B2A-T1 — configurable multi-trade registry', () => {
  it('ships the multi-trade baseline and accepts new configured trades', async (t) => {
    if (!ready(t)) return;

    const list = await api()
      .get('/api/v1/work-order-trade-categories?status=ACTIVE')
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const codes = list.body.data.map((row: { code: string }) => row.code);
    for (const code of [
      'AIR_CONDITIONING',
      'PLUMBING',
      'ELECTRICAL_MINOR',
      'SANITARY',
      'DOOR_LOCK',
      'FURNITURE',
      'PAINTING',
      'CEILING',
      'TILING',
      'INSTALLATION',
      'GENERAL_REPAIR',
    ]) {
      assert.ok(codes.includes(code), `${code} must be seeded`);
    }
    // The baseline is DATA: an AC-only platform would not carry these.
    const electrical = list.body.data.find(
      (row: { code: string }) => row.code === 'ELECTRICAL_MINOR',
    );
    assert.equal(electrical.riskLevel, 'HIGH');
    assert.equal(electrical.handymanDisciplineCode, 'ELECTRICAL');

    // A trade the platform never shipped is configuration, not a deploy.
    const created = await api()
      .post('/api/v1/work-order-trade-categories')
      .set(auth())
      .send({
        code: 'POOL_EQUIPMENT',
        name: 'Pool Equipment Service',
        riskLevel: 'MEDIUM',
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'ACTIVE');

    const duplicate = await api()
      .post('/api/v1/work-order-trade-categories')
      .set(auth())
      .send({ code: 'POOL_EQUIPMENT', name: 'Duplicate' });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'WORK_ORDER_TRADE_CATEGORY_ALREADY_EXISTS',
    );

    // The code is immutable: historical decisions quote it.
    const rename = await api()
      .patch(`/api/v1/work-order-trade-categories/${created.body.data.id}`)
      .set(auth())
      .send({ code: 'POOL_SERVICE' });
    assert.equal(rename.status, 400);

    const updated = await api()
      .patch(`/api/v1/work-order-trade-categories/${created.body.data.id}`)
      .set(auth())
      .send({ name: 'Pool & Water Feature Service', riskLevel: 'HIGH' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.riskLevel, 'HIGH');

    const deactivated = await api()
      .post(
        `/api/v1/work-order-trade-categories/${created.body.data.id}/deactivate`,
      )
      .set(auth());
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    // An INACTIVE trade can no longer classify a Work Order.
    const r = await realm();
    const wo = await workOrder(r);
    const refused = await classify(wo.id, {
      tradeCategoryId: created.body.data.id,
    });
    assert.equal(refused.status, 409);
    assert.equal(
      refused.body.error.code,
      'WORK_ORDER_TRADE_CATEGORY_INVALID_STATE',
    );
  });
});

// ---------------------------------------------------------------------------
// T2 — classification is authoritative, optional and Building-scoped
// ---------------------------------------------------------------------------

describe('PART 03B2A-T2 — Work Order classification', () => {
  it('records the Operations triage decision with a default and an override', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const wo = await workOrder(r);
    const ac = await tradeCategoryId('AIR_CONDITIONING');

    const classified = await classify(wo.id, { tradeCategoryId: ac });
    assert.equal(classified.status, 200, JSON.stringify(classified.body));
    assert.equal(classified.body.data.tradeCategoryId, ac);
    assert.equal(classified.body.data.tradeCategoryCode, 'AIR_CONDITIONING');
    // The category's configured default applies when Operations does not override.
    assert.equal(classified.body.data.riskLevel, 'MEDIUM');
    assert.ok(classified.body.data.classifiedAt);
    assert.equal(classified.body.data.classifiedByUserId, adminUserId);

    const read = await api()
      .get(`/api/v1/work-orders/${wo.id}/classification`)
      .set(auth());
    assert.equal(read.status, 200);
    assert.equal(read.body.data.tradeCategoryCode, 'AIR_CONDITIONING');

    const overridden = await classify(wo.id, {
      tradeCategoryId: ac,
      riskLevel: 'HIGH',
    });
    assert.equal(overridden.body.data.riskLevel, 'HIGH');

    // Clearing returns the Work Order to the unrestricted path.
    const cleared = await classify(wo.id, { tradeCategoryId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.tradeCategoryId, null);
    assert.equal(cleared.body.data.riskLevel, null);

    const events = await api()
      .get(`/api/v1/work-orders/${wo.id}/history?eventType=WORK_ORDER_CLASSIFIED`)
      .set(auth());
    assert.equal(events.status, 200);
    assert.equal(events.body.data.length, 2);
  });

  it('refuses classification across Client/Building and on a terminal Work Order', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const other = await realm();
    const wo = await workOrder(r);
    const plumbing = await tradeCategoryId('PLUMBING');

    const stranger = await createAdminUser();
    const denied = await classify(
      wo.id,
      { tradeCategoryId: plumbing },
      stranger.token,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    // The other Building's manager is refused too.
    const otherManager = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherManager.userId, {
      buildingId: other.building.id,
    });
    assert.equal(
      (await classify(wo.id, { tradeCategoryId: plumbing }, otherManager.token))
        .status,
      403,
    );

    await q(`UPDATE work_orders SET status = 'CANCELLED' WHERE id = $1`, [wo.id]);
    const terminal = await classify(wo.id, { tradeCategoryId: plumbing });
    assert.equal(terminal.status, 409);
    assert.equal(
      terminal.body.error.code,
      'WORK_ORDER_TRADE_CATEGORY_INVALID_STATE',
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — AC: a configured SKILL requirement is enforced
// ---------------------------------------------------------------------------

describe('PART 03B2A-T3 — AC skill requirement enforcement', () => {
  it('refuses an unqualified worker and records the decision when qualified', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const ac = await tradeCategoryId('AIR_CONDITIONING');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_AC_${suffix()}`,
      name: 'AC Troubleshooting',
      category: 'TECHNICAL',
    });
    const created = await addRequirement(ac, r.client.id, {
      requirementType: 'SKILL',
      enforcementLevel: 'MANDATORY',
      skillId: skill.id,
      minimumProficiencyLevel: 'INTERMEDIATE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.tradeCategoryId, ac);
    assert.equal(created.body.data.serviceCatalogId, null);

    const wo = await workOrder(r, 'AC_NOT_COOLING');
    await classify(wo.id, { tradeCategoryId: ac });

    const unqualified = await worker(r);
    const refused = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: unqualified.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.code,
      'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
    );
    assert.equal(refused.body.error.details[0].reason, 'SKILL_MISSING');
    assert.equal(refused.body.error.details[0].skillCode, skill.code);
    assert.equal(
      refused.body.error.details[0].workforceProfileId,
      unqualified.id,
    );

    // Nothing was written: the refusal is a rollback, not a partial assign.
    assert.equal((await assignmentRows(wo.id)).length, 0);
    assert.equal((await decisionRows(wo.id)).length, 0);

    await assignSkillToWorkforce({
      workforceProfileId: unqualified.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });
    const accepted = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: unqualified.id,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal((await assignmentRows(wo.id)).length, 1);

    const rows = await decisionRows(wo.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'ASSIGNED');
    assert.equal(rows[0].assignee_type, 'WORKFORCE');
    assert.equal(rows[0].trade_category_code, 'AIR_CONDITIONING');
    assert.equal(rows[0].risk_level, 'MEDIUM');
    assert.equal(rows[0].satisfied, true);
    assert.equal(rows[0].reason, null);
    assert.equal(rows[0].evidence_proficiency_level, 'ADVANCED');
  });
});

// ---------------------------------------------------------------------------
// T4/T5 — plumbing certification, minor-electrical expiry
// ---------------------------------------------------------------------------

describe('PART 03B2A-T4 — plumbing certification requirement', () => {
  it('requires a VERIFIED certificate only because one was configured', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const plumbing = await tradeCategoryId('PLUMBING');
    const requirement = await addRequirement(plumbing, r.client.id, {
      requirementType: 'CERTIFICATION',
      enforcementLevel: 'MANDATORY',
      certificateName: 'Sertifikat Plumbing',
    });
    assert.equal(requirement.status, 201, JSON.stringify(requirement.body));

    const wo = await workOrder(r, 'PLUMBING_LEAK');
    await classify(wo.id, { tradeCategoryId: plumbing });

    const plumber = await worker(r);
    await giveCertificate(r, plumber.id, {
      certificateName: 'Sertifikat Plumbing',
      verify: false,
    });
    const unverified = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: plumber.id,
    });
    assert.equal(unverified.status, 409, JSON.stringify(unverified.body));
    assert.equal(
      unverified.body.error.details[0].reason,
      'CERTIFICATION_UNVERIFIED',
    );

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
    const accepted = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: plumber.id,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    const rows = await decisionRows(wo.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requirement_type, 'CERTIFICATION');
    assert.equal(rows[0].evidence_verification_status, 'VERIFIED');
    assert.ok(rows[0].evidence_certification_id);
  });
});

describe('PART 03B2A-T5 — minor electrical expiry', () => {
  it('refuses an expired certificate for an electrical-minor job', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const electrical = await tradeCategoryId('ELECTRICAL_MINOR');
    const created = await addRequirement(electrical, r.client.id, {
      requirementType: 'CERTIFICATION',
      enforcementLevel: 'MANDATORY',
      certificateName: 'Sertifikat Kelistrikan',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const wo = await workOrder(r, 'ELECTRICAL_SOCKET');
    await classify(wo.id, { tradeCategoryId: electrical });

    const electrician = await worker(r);
    await giveCertificate(r, electrician.id, {
      certificateName: 'Sertifikat Kelistrikan',
      verify: true,
      expired: true,
    });

    const refused = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: electrician.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.details[0].reason, 'CERTIFICATION_EXPIRED');
    assert.equal((await decisionRows(wo.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// T6/T7 — no global mandatory certification
// ---------------------------------------------------------------------------

describe('PART 03B2A-T6 — door repair and painting', () => {
  it('assigns an unconfigured trade and only ADVISES a RECOMMENDED gap', async (t) => {
    if (!ready(t)) return;
    const r = await realm();

    // DOOR_LOCK: nothing configured → completely unrestricted.
    const door = await tradeCategoryId('DOOR_LOCK');
    const doorWo = await workOrder(r, 'DOOR_HANDLE');
    await classify(doorWo.id, { tradeCategoryId: door });
    const handyman = await worker(r);
    const doorAssign = await assign(doorWo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: handyman.id,
    });
    assert.equal(doorAssign.status, 201, JSON.stringify(doorAssign.body));
    assert.equal((await decisionRows(doorWo.id)).length, 0);

    // PAINTING: a RECOMMENDED requirement never blocks, but it IS recorded.
    const painting = await tradeCategoryId('PAINTING');
    const paintSkill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_PAINT_${suffix()}`,
      name: 'Wall Painting',
      category: 'TECHNICAL',
    });
    const recommended = await addRequirement(painting, r.client.id, {
      requirementType: 'SKILL',
      enforcementLevel: 'RECOMMENDED',
      skillId: paintSkill.id,
      minimumProficiencyLevel: 'INTERMEDIATE',
    });
    assert.equal(recommended.status, 201, JSON.stringify(recommended.body));

    const paintWo = await workOrder(r, 'PAINTING_WALL');
    await classify(paintWo.id, { tradeCategoryId: painting });
    const painter = await worker(r);
    const paintAssign = await assign(paintWo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: painter.id,
    });
    assert.equal(paintAssign.status, 201, JSON.stringify(paintAssign.body));

    const rows = await decisionRows(paintWo.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].enforcement_level, 'RECOMMENDED');
    assert.equal(rows[0].satisfied, false);
    assert.equal(rows[0].reason, 'SKILL_MISSING');
  });
});

describe('PART 03B2A-T7 — generic miscellaneous repair', () => {
  it('keeps a generic repair assignable to a team without any requirement', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const general = await tradeCategoryId('GENERAL_REPAIR');
    const wo = await workOrder(r, 'MISC_REPAIR');
    await classify(wo.id, { tradeCategoryId: general });

    const team = await teamService.createTeam({
      departmentId: r.department.id,
      code: `TM_${suffix()}`,
      name: 'Handyman Team',
    });
    await worker(r, { teamId: team.id });
    await worker(r, { teamId: team.id });

    const assigned = await assign(wo.id, {
      assigneeType: 'TEAM',
      teamId: team.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal((await decisionRows(wo.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// T8 — a team is evaluated as one unit (multi-worker crew)
// ---------------------------------------------------------------------------

describe('PART 03B2A-T8 — multi-worker team', () => {
  it('requires EVERY active member to qualify', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const sanitary = await tradeCategoryId('SANITARY');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_SAN_${suffix()}`,
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

    const wo = await workOrder(r, 'SANITARY_CLOG');
    await classify(wo.id, { tradeCategoryId: sanitary });

    const team = await teamService.createTeam({
      departmentId: r.department.id,
      code: `TM_${suffix()}`,
      name: 'Sanitary Team',
    });
    const lead = await worker(r, { teamId: team.id });
    const helper = await worker(r, { teamId: team.id });
    await assignSkillToWorkforce({
      workforceProfileId: lead.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });

    const refused = await assign(wo.id, {
      assigneeType: 'TEAM',
      teamId: team.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(
      refused.body.error.code,
      'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
    );
    assert.ok(
      refused.body.error.details.some(
        (gap: { workforceProfileId: string }) =>
          gap.workforceProfileId === helper.id,
      ),
      'the non-qualified helper must be named',
    );
    assert.equal((await assignmentRows(wo.id)).length, 0);

    await assignSkillToWorkforce({
      workforceProfileId: helper.id,
      skillId: skill.id,
      proficiencyLevel: 'BASIC',
    });
    const accepted = await assign(wo.id, {
      assigneeType: 'TEAM',
      teamId: team.id,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal((await decisionRows(wo.id)).length, 2);
  });
});

// ---------------------------------------------------------------------------
// T9 — vendor: at least one bound worker must qualify
// ---------------------------------------------------------------------------

describe('PART 03B2A-T9 — vendor company assignment', () => {
  it('needs at least one qualified bound worker, never all of them', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const ceiling = await tradeCategoryId('CEILING');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_CEIL_${suffix()}`,
      name: 'Ceiling Works',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(ceiling, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'MANDATORY',
          skillId: skill.id,
          minimumProficiencyLevel: 'BASIC',
        })
      ).status,
      201,
    );

    const vendor = await vendorService.createVendor({
      clientId: r.client.id,
      vendorCode: `VN_${suffix()}`,
      vendorName: 'Ceiling Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: r.building.id,
    });
    const unqualifiedWorker = await worker(r, { type: 'EXTERNAL' });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: vendor.id,
      workforceProfileId: unqualifiedWorker.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });

    const wo = await workOrder(r, 'CEILING_STAIN');
    await classify(wo.id, { tradeCategoryId: ceiling });

    const refused = await assign(wo.id, {
      assigneeType: 'VENDOR',
      vendorId: vendor.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED');

    // One qualified bound worker is enough — the company is not asked to make
    // every employee certified.
    await assignSkillToWorkforce({
      workforceProfileId: unqualifiedWorker.id,
      skillId: skill.id,
      proficiencyLevel: 'INTERMEDIATE',
    });
    const accepted = await assign(wo.id, {
      assigneeType: 'VENDOR',
      vendorId: vendor.id,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal((await decisionRows(wo.id)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// T10 — reassignment is gated and rolls back
// ---------------------------------------------------------------------------

describe('PART 03B2A-T10 — reassignment', () => {
  it('refuses an unqualified reassignment and keeps the ACTIVE assignment', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const ac = await tradeCategoryId('AIR_CONDITIONING');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_AC2_${suffix()}`,
      name: 'AC Refrigerant',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(ac, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'MANDATORY',
          skillId: skill.id,
          minimumProficiencyLevel: 'INTERMEDIATE',
        })
      ).status,
      201,
    );

    const wo = await workOrder(r, 'AC_SERVICE');
    await classify(wo.id, { tradeCategoryId: ac });

    const qualified = await worker(r);
    const unqualified = await worker(r);
    await assignSkillToWorkforce({
      workforceProfileId: qualified.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });
    const first = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: qualified.id,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const refused = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: unqualified.id,
    });
    assert.equal(refused.status, 409);

    // Reassign through the PATCH form (existing workflow, no parallel path).
    const reassignDenied = await api()
      .patch(`/api/v1/work-orders/${wo.id}/assignments/${first.body.data.id}`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: unqualified.id });
    assert.equal(reassignDenied.status, 409, JSON.stringify(reassignDenied.body));
    assert.equal(
      reassignDenied.body.error.code,
      'WORK_ORDER_ASSIGNMENT_COMPETENCY_REQUIRED',
    );

    const active = await q(
      `SELECT id, workforce_profile_id, status FROM work_order_assignments
        WHERE work_order_id = $1 AND status = 'ACTIVE'`,
      [wo.id],
    );
    assert.equal(active.rowCount, 1);
    assert.equal(active.rows[0].id, first.body.data.id);
    assert.equal(active.rows[0].workforce_profile_id, qualified.id);

    // The failed reassign left the ledger untouched (still the single ASSIGNED row).
    const rows = await decisionRows(wo.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'ASSIGNED');

    // A qualified reassignment is appended as REASSIGNED.
    const second = await worker(r);
    await assignSkillToWorkforce({
      workforceProfileId: second.id,
      skillId: skill.id,
      proficiencyLevel: 'EXPERT',
    });
    const reassigned = await api()
      .patch(`/api/v1/work-orders/${wo.id}/assignments/${first.body.data.id}`)
      .set(auth())
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: second.id });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));

    const after = await decisionRows(wo.id);
    assert.equal(after.length, 2);
    assert.equal(after[1].action, 'REASSIGNED');
    assert.equal(after[1].evidence_proficiency_level, 'EXPERT');
  });
});

// ---------------------------------------------------------------------------
// T11 — ledger privacy + append-only
// ---------------------------------------------------------------------------

describe('PART 03B2A-T11 — decision ledger integrity', () => {
  it('stores minimum evidence only and rejects UPDATE/DELETE', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const plumbing = await tradeCategoryId('PLUMBING');
    assert.equal(
      (
        await addRequirement(plumbing, r.client.id, {
          requirementType: 'CERTIFICATION',
          enforcementLevel: 'MANDATORY',
          certificateName: 'Sertifikat Plumbing Lanjutan',
        })
      ).status,
      201,
    );
    const wo = await workOrder(r, 'PLUMBING_PIPE');
    await classify(wo.id, { tradeCategoryId: plumbing });

    const plumber = await worker(r);
    const certificateId = await giveCertificate(r, plumber.id, {
      certificateName: 'Sertifikat Plumbing Lanjutan',
      verify: true,
    });
    const accepted = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: plumber.id,
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    const serialized = JSON.stringify((await decisionRows(wo.id))[0]);
    assert.ok(!serialized.includes('CERT-'), 'no certificate number in the ledger');
    assert.ok(!serialized.includes('certifications/'), 'no storage key in the ledger');
    assert.ok(serialized.includes(certificateId), 'the opaque certificate id is kept');

    await assert.rejects(
      () =>
        q(
          `UPDATE work_order_assignment_competency_decisions
              SET satisfied = false WHERE work_order_id = $1`,
          [wo.id],
        ),
      /append-only/i,
    );
    await assert.rejects(
      () =>
        q(
          `DELETE FROM work_order_assignment_competency_decisions
            WHERE work_order_id = $1`,
          [wo.id],
        ),
      /append-only/i,
    );
  });
});

// ---------------------------------------------------------------------------
// T12 — decision history endpoint
// ---------------------------------------------------------------------------

describe('PART 03B2A-T12 — decision history endpoint', () => {
  it('is authenticated, Building-scoped and paginated', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const ac = await tradeCategoryId('AIR_CONDITIONING');
    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_HIST_${suffix()}`,
      name: 'AC History Skill',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(ac, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'MANDATORY',
          skillId: skill.id,
          minimumProficiencyLevel: 'BASIC',
        })
      ).status,
      201,
    );

    const wo = await workOrder(r, 'AC_HISTORY');
    await classify(wo.id, { tradeCategoryId: ac });
    const first = await worker(r);
    await assignSkillToWorkforce({
      workforceProfileId: first.id,
      skillId: skill.id,
      proficiencyLevel: 'BASIC',
    });
    assert.equal(
      (
        await assign(wo.id, {
          assigneeType: 'WORKFORCE',
          workforceProfileId: first.id,
        })
      ).status,
      201,
    );
    const second = await worker(r);
    await assignSkillToWorkforce({
      workforceProfileId: second.id,
      skillId: skill.id,
      proficiencyLevel: 'EXPERT',
    });
    const current = await api()
      .get(`/api/v1/work-orders/${wo.id}/assignments/current`)
      .set(auth());
    assert.equal(
      (
        await api()
          .patch(`/api/v1/work-orders/${wo.id}/assignments/${current.body.data.id}`)
          .set(auth())
          .send({ assigneeType: 'WORKFORCE', workforceProfileId: second.id })
      ).status,
      200,
    );

    const base = `/api/v1/work-orders/${wo.id}/assignments/competency-decisions`;
    assert.equal((await api().get(base)).status, 401);

    const other = await realm();
    const otherManager = await createAdminUser();
    await buildingAssignmentService.createAssignment(otherManager.userId, {
      buildingId: other.building.id,
    });
    const denied = await api().get(base).set(auth(otherManager.token));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const page1 = await api().get(`${base}?page=1&pageSize=1`).set(auth());
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.equal(page1.body.data.length, 1);
    assert.deepEqual(page1.body.meta, {
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
    assert.equal(page1.body.data[0].action, 'REASSIGNED');

    const filtered = await api().get(`${base}?action=ASSIGNED`).set(auth());
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].action, 'ASSIGNED');

    const none = await api()
      .get(`${base}?satisfied=false&page=1&pageSize=10`)
      .set(auth());
    assert.equal(none.body.data.length, 0);
    assert.equal(none.body.meta.total, 0);

    // Without paging params the shared BE-25A contract carries an empty meta.
    const unpaged = await api().get(base).set(auth());
    assert.equal(unpaged.status, 200);
    assert.equal(unpaged.body.data.length, 2);
    assert.deepEqual(unpaged.body.meta, {});

    const invalid = await api().get(`${base}?action=DELETED`).set(auth());
    assert.equal(invalid.status, 400);
  });
});

// ---------------------------------------------------------------------------
// T13 — unclassified Work Order stays assignable
// ---------------------------------------------------------------------------

describe('PART 03B2A-T13 — backward compatibility', () => {
  it('assigns an unclassified Work Order exactly as before', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const wo = await workOrder(r);
    const profile = await worker(r);
    const assigned = await assign(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: profile.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal((await decisionRows(wo.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// T14 — Customer Care Service Request → Work Order → Assignment (no catalog)
// ---------------------------------------------------------------------------

describe('PART 03B2A-T14 — Customer Care end-to-end without a Service Catalog', () => {
  it('runs Tenant → Customer Care → SR → WO → classification → assignment', async (t) => {
    if (!ready(t)) return;
    const r = await realm();

    // A free-description request: no Service Catalog entry is created anywhere
    // in this test, and `requestType` stays a free-text business label.
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
      .send({ picName: 'Tenant PIC', email: 'pic@tenant.example.com' });
    assert.equal(pic.status, 201, JSON.stringify(pic.body));
    assert.equal(
      (
        await api()
          .post(`/api/v1/tenant-companies/${company.body.data.id}/spaces`)
          .set(auth())
          .send({ buildingId: r.building.id, spaceId: space.id })
      ).status,
      201,
    );
    assert.equal(
      (
        await api()
          .post(`/api/v1/tenant-companies/${company.body.data.id}/building-contexts`)
          .set(auth())
          .send({ buildingId: r.building.id })
      ).status,
      201,
    );

    const request = await api()
      .post(`/api/v1/tenant-companies/${company.body.data.id}/service-requests`)
      .set(auth())
      .send({
        tenantPicId: pic.body.data.id,
        buildingId: r.building.id,
        spaceId: space.id,
        requestNumber: `SR_${suffix()}`,
        requestType: 'PLUMBING',
        title: 'Wastafel bocor di kamar mandi',
        description: 'Air menetes dari pipa bawah wastafel sejak pagi.',
        priority: 'HIGH',
      });
    assert.equal(request.status, 201, JSON.stringify(request.body));
    assert.equal(request.body.data.status, 'OPEN');

    const workRequest = await api()
      .post(`/api/v1/tenant-service-requests/${request.body.data.id}/work-request`)
      .set(auth());
    assert.equal(workRequest.status, 201, JSON.stringify(workRequest.body));

    const workOrderBinding = await api()
      .post(`/api/v1/tenant-service-requests/${request.body.data.id}/work-order`)
      .set(auth())
      .send({ workOrderNumber: `WO_${suffix()}` });
    assert.equal(workOrderBinding.status, 201, JSON.stringify(workOrderBinding.body));
    const workOrderId = workOrderBinding.body.data.workOrderId as string;

    const created = await q(
      `SELECT work_type, trade_category_id,
              (SELECT COUNT(*)::int FROM service_catalog) AS catalog_rows
         FROM work_orders WHERE id = $1`,
      [workOrderId],
    );
    assert.equal(created.rows[0].work_type, 'PLUMBING');
    assert.equal(created.rows[0].trade_category_id, null);
    // No Service Catalog row exists in this Client — the flow never needed one.
    assert.equal(created.rows[0].catalog_rows, 0);

    // Operations classifies the job during triage and configures the skill.
    const plumbing = await tradeCategoryId('PLUMBING');
    const classified = await classify(workOrderId, {
      tradeCategoryId: plumbing,
      riskLevel: 'MEDIUM',
    });
    assert.equal(classified.status, 200, JSON.stringify(classified.body));

    const skill = await skillService.createSkill({
      clientId: r.client.id,
      code: `SK_E2E_${suffix()}`,
      name: 'Plumbing Repair',
      category: 'TECHNICAL',
    });
    assert.equal(
      (
        await addRequirement(plumbing, r.client.id, {
          requirementType: 'SKILL',
          enforcementLevel: 'MANDATORY',
          skillId: skill.id,
          minimumProficiencyLevel: 'BASIC',
        })
      ).status,
      201,
    );

    const plumber = await worker(r);
    const refused = await assign(workOrderId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: plumber.id,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));

    await assignSkillToWorkforce({
      workforceProfileId: plumber.id,
      skillId: skill.id,
      proficiencyLevel: 'INTERMEDIATE',
    });
    const assigned = await assign(workOrderId, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: plumber.id,
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

    const rows = await decisionRows(workOrderId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trade_category_code, 'PLUMBING');
    assert.equal(rows[0].risk_level, 'MEDIUM');
    assert.equal(rows[0].satisfied, true);

    const history = await api()
      .get(`/api/v1/work-orders/${workOrderId}/history`)
      .set(auth());
    const types = history.body.data.map((event: { eventType: string }) => event.eventType);
    assert.ok(types.includes('WORK_ORDER_CLASSIFIED'));
    assert.ok(types.includes('WORK_ORDER_ASSIGNED'));
  });
});

// ---------------------------------------------------------------------------
// T15/T16 — isolation and RBAC
// ---------------------------------------------------------------------------

describe('PART 03B2A-T15 — configuration isolation', () => {
  it('scopes trade requirements to a Client the caller can actually reach', async (t) => {
    if (!ready(t)) return;
    const mine = await realm();
    const foreign = await realm(null);
    const ac = await tradeCategoryId('AIR_CONDITIONING');

    const foreignClient = await addRequirement(ac, foreign.client.id, {
      requirementType: 'SKILL',
      enforcementLevel: 'MANDATORY',
      skillId: (
        await skillService.createSkill({
          clientId: foreign.client.id,
          code: `SK_F_${suffix()}`,
          name: 'Foreign Skill',
          category: 'TECHNICAL',
        })
      ).id,
      minimumProficiencyLevel: 'BASIC',
    });
    assert.equal(foreignClient.status, 403, JSON.stringify(foreignClient.body));
    assert.equal(foreignClient.body.error.code, 'BUILDING_ACCESS_DENIED');

    const foreignSkill = await skillService.createSkill({
      clientId: foreign.client.id,
      code: `SK_F2_${suffix()}`,
      name: 'Foreign Skill 2',
      category: 'TECHNICAL',
    });
    const mismatch = await addRequirement(ac, mine.client.id, {
      requirementType: 'SKILL',
      enforcementLevel: 'MANDATORY',
      skillId: foreignSkill.id,
      minimumProficiencyLevel: 'BASIC',
    });
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(
      mismatch.body.error.code,
      'SERVICE_COMPETENCY_REQUIREMENT_SKILL_MISMATCH',
    );

    const list = await api()
      .get(
        `/api/v1/work-order-trade-categories/${ac}/competency-requirements?clientId=${foreign.client.id}`,
      )
      .set(auth());
    assert.equal(list.status, 403);
  });
});

describe('PART 03B2A-T16 — RBAC', () => {
  it('requires the Work Order permissions and never a broader one', async (t) => {
    if (!ready(t)) return;
    const r = await realm();
    const wo = await workOrder(r);
    const profile = await worker(r);
    const plain = await createPlainSession();

    assert.equal(
      (
        await assign(wo.id, {
          assigneeType: 'WORKFORCE',
          workforceProfileId: profile.id,
        }, plain)
      ).status,
      403,
    );
    assert.equal(
      (await classify(wo.id, { tradeCategoryId: null }, plain)).status,
      403,
    );
    assert.equal(
      (
        await api()
          .post('/api/v1/work-order-trade-categories')
          .set(auth(plain))
          .send({ code: `RBAC_${suffix()}`, name: 'Denied' })
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .get(`/api/v1/work-orders/${wo.id}/classification`)
          .set(auth(plain))
      ).status,
      403,
    );
  });
});
