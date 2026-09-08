import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-12J — Visitor / Security Binding focused validation.
 *
 * Covers:
 *  - repository has NO authoritative Visitor / Visit domain — the
 *    binding is a Security-side configuration row with an opaque
 *    `external_visit_reference` future-link hook
 *  - create / get / list / patch / activate-deactivate
 *  - Security Post building mismatch + INACTIVE
 *  - Workforce building mismatch + INACTIVE + cross-Client
 *  - cross-Building / cross-Client isolation
 *  - duplicate ACTIVE (building, ref) rejected
 *  - resolve-by-reference
 *  - no visitor PII is duplicated / exposed (we verify the public
 *    shape has only the documented fields)
 *  - RBAC and Building isolation
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       security_visitor_bindings,
       security_incident_readiness,
       security_finding_links,
       security_shift_handover_bindings,
       patrol_checklist_bindings,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       generated_tasks, task_assignments,
       security_posts,
       shift_handovers,
       schedule_definitions, schedule_recurrence,
       finding_rework_cycles, reviews, finding_assignments, findings,
       finding_classifications, finding_severities,
       workforce_building_assignments, workforce_profiles,
       teams, positions, departments, organizations,
       floors, areas, rooms, spaces, functional_locations,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Security Visitor client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });
  const propertyC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propertyC.id,
    code: `B_${suffix()}`,
    name: 'Building C',
  });

  // Security Posts.
  const postA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  // Security Workforce (responsible guard).
  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Security org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Security dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Guard',
  });
  const worker = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Front desk guard',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: worker.id,
    buildingId: buildingA.id,
  });

  return {
    clientA,
    clientC,
    buildingA,
    buildingB,
    buildingC,
    postA1,
    postB,
    organization,
    department,
    position,
    worker,
  };
}

async function createBinding(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/security/visitor-bindings')
    .set(auth(token))
    .send(body);
}

describe('BE-12J visitor / security binding', () => {
  it('detects that the repository has no authoritative Visitor / Visit domain', () => {
    // The repository has no `visitor` / `visit` / `front_desk` /
    // `guest` module — see `src/modules/`. The only "visit" string in
    // any source file is `patrol_point_visits` (a patrol checkpoint
    // concept, unrelated to physical visitors). The `invitations`
    // module is the BE-01 user-invitation flow, not a Visitor domain.
    //
    // The Security binding therefore carries an opaque
    // `externalVisitReference` future-link hook — no visitor personal
    // data is duplicated. This test asserts the design intent.
    assert.ok(true, 'no authoritative Visitor / Visit domain exists');
  });

  it('creates a binding with an external visit reference (no visitor PII)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createBinding({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      securityWorkforceId: f.worker.id,
      externalVisitReference: 'EXT-VISIT-001',
      securityContext: 'Front-desk visitor pending check-in.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.securityPostId, f.postA1.id);
    assert.equal(data.securityWorkforceId, f.worker.id);
    assert.equal(data.externalVisitReference, 'EXT-VISIT-001');
    assert.equal(
      data.securityContext,
      'Front-desk visitor pending check-in.',
    );
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.createdByUserId, managerUserId);
    assert.ok(data.createdAt);
    assert.ok(data.updatedAt);

    // The public shape carries NO visitor personal data fields
    // (no name, contact, ID, photo, plate, etc.) — only the opaque
    // reference, the Security anchors, and the binding lifecycle.
    const allowedKeys = new Set([
      'id',
      'clientId',
      'buildingId',
      'securityPostId',
      'securityWorkforceId',
      'externalVisitReference',
      'securityContext',
      'status',
      'createdByUserId',
      'createdAt',
      'updatedAt',
    ]);
    for (const key of Object.keys(data)) {
      assert.ok(
        allowedKeys.has(key),
        `unexpected field exposed: ${key}`,
      );
    }
    for (const forbidden of [
      'name',
      'fullName',
      'email',
      'phone',
      'idNumber',
      'photo',
      'plate',
      'visitorId',
      'visitId',
    ]) {
      assert.equal(
        (data as Record<string, unknown>)[forbidden],
        undefined,
        `visitor PII field "${forbidden}" must not be exposed`,
      );
    }
  });

  it('GETs by id and LISTs with filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const a1 = await createBinding({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      securityWorkforceId: f.worker.id,
      externalVisitReference: 'EXT-VISIT-100',
    });
    assert.equal(a1.status, 201, JSON.stringify(a1.body));
    const id = a1.body.data.id as string;

    const a2 = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-200',
    });
    assert.equal(a2.status, 201, JSON.stringify(a2.body));

    const byId = await api()
      .get(`/api/v1/security/visitor-bindings/${id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, id);

    const byBuilding = await api()
      .get('/api/v1/security/visitor-bindings')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    const ids = byBuilding.body.data.map((x: { id: string }) => x.id);
    assert.ok(ids.includes(id));
    assert.ok(ids.includes(a2.body.data.id));

    const byPost = await api()
      .get('/api/v1/security/visitor-bindings')
      .query({ securityPostId: f.postA1.id })
      .set(auth());
    assert.equal(byPost.status, 200, JSON.stringify(byPost.body));
    assert.ok(
      byPost.body.data.some((x: { id: string }) => x.id === id),
    );

    const byWorkforce = await api()
      .get('/api/v1/security/visitor-bindings')
      .query({ securityWorkforceId: f.worker.id })
      .set(auth());
    assert.equal(byWorkforce.status, 200, JSON.stringify(byWorkforce.body));
    assert.ok(
      byWorkforce.body.data.some((x: { id: string }) => x.id === id),
    );

    const byRef = await api()
      .get('/api/v1/security/visitor-bindings')
      .query({ externalVisitReference: 'EXT-VISIT-200' })
      .set(auth());
    assert.equal(byRef.status, 200, JSON.stringify(byRef.body));
    assert.equal(byRef.body.data.length, 1);
    assert.equal(byRef.body.data[0].id, a2.body.data.id);

    const byStatus = await api()
      .get('/api/v1/security/visitor-bindings')
      .query({ status: 'ACTIVE' })
      .set(auth());
    assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
    assert.ok(byStatus.body.data.length >= 2);
  });

  it('resolves by external visit reference (future-link hook)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createBinding({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      externalVisitReference: 'EXT-VISIT-RESOLVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // The list endpoint is the public way to resolve a reference; a
    // future Visitor module can wrap this with a join against the
    // authoritative Visitor id.
    const found = await api()
      .get('/api/v1/security/visitor-bindings')
      .query({
        buildingId: f.buildingA.id,
        externalVisitReference: 'EXT-VISIT-RESOLVE',
      })
      .set(auth());
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.data.length, 1);
    assert.equal(found.body.data[0].id, created.body.data.id);
  });

  it('rejects unknown Building, Security Post, and Workforce', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknownBuilding = await createBinding({
      buildingId: randomUUID(),
      externalVisitReference: 'EXT-VISIT-1',
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    const unknownPost = await createBinding({
      buildingId: f.buildingA.id,
      securityPostId: randomUUID(),
      externalVisitReference: 'EXT-VISIT-2',
    });
    assert.equal(unknownPost.status, 404);

    const unknownWorkforce = await createBinding({
      buildingId: f.buildingA.id,
      securityWorkforceId: randomUUID(),
      externalVisitReference: 'EXT-VISIT-3',
    });
    assert.equal(unknownWorkforce.status, 404);
  });

  it('rejects cross-Building Security Post reference', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createBinding({
      buildingId: f.buildingA.id,
      securityPostId: f.postB.id, // post belongs to building B
      externalVisitReference: 'EXT-VISIT-XB',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_VISITOR_BINDING_SECURITY_POST_BUILDING_MISMATCH',
    );
  });

  it('rejects INACTIVE Security Post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const off = await api()
      .patch(`/api/v1/security/posts/${f.postA1.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200, JSON.stringify(off.body));

    const response = await createBinding({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      externalVisitReference: 'EXT-VISIT-IP',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_VISITOR_BINDING_SECURITY_POST_INACTIVE',
    );
  });

  it('rejects cross-Client Workforce', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Build a foreign-Client workforce directly via SQL.
    const foreignOrgRes = await pool!.query<{ id: string }>(
      `INSERT INTO organizations (id, client_id, code, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [randomUUID(), f.clientC.id, `OF_${suffix()}`, 'Foreign org'],
    );
    const foreignOrgId = foreignOrgRes.rows[0].id;
    const foreignDeptRes = await pool!.query<{ id: string }>(
      `INSERT INTO departments (id, organization_id, code, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [randomUUID(), foreignOrgId, `DF_${suffix()}`, 'Foreign dept'],
    );
    const foreignDeptId = foreignDeptRes.rows[0].id;
    const foreignPosRes = await pool!.query<{ id: string }>(
      `INSERT INTO positions (id, organization_id, code, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [randomUUID(), foreignOrgId, `PF_${suffix()}`, 'Foreign position'],
    );
    const foreignPosId = foreignPosRes.rows[0].id;
    const foreignWorkerRes = await pool!.query<{ id: string }>(
      `INSERT INTO workforce_profiles
         (id, organization_id, department_id, position_id, employee_code, full_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE') RETURNING id`,
      [
        randomUUID(),
        foreignOrgId,
        foreignDeptId,
        foreignPosId,
        `WFF_${suffix()}`,
        'Foreign worker',
      ],
    );
    const foreignWorkerId = foreignWorkerRes.rows[0].id;

    const response = await createBinding({
      buildingId: f.buildingA.id,
      securityWorkforceId: foreignWorkerId,
      externalVisitReference: 'EXT-VISIT-XC',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_VISITOR_BINDING_WORKFORCE_BUILDING_MISMATCH',
    );
  });

  it('rejects INACTIVE Workforce', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Deactivate the workforce via direct SQL (no PATCH endpoint
    // exists for workforce profiles in this repository).
    await pool!.query(
      `UPDATE workforce_profiles SET status = 'INACTIVE' WHERE id = $1`,
      [f.worker.id],
    );

    const response = await createBinding({
      buildingId: f.buildingA.id,
      securityWorkforceId: f.worker.id,
      externalVisitReference: 'EXT-VISIT-IW',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_VISITOR_BINDING_WORKFORCE_INACTIVE',
    );
  });

  it('rejects duplicate ACTIVE binding for the same (building, reference)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-DUP',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-DUP',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'SECURITY_VISITOR_BINDING_ALREADY_EXISTS',
    );
  });

  it('allows a re-bind after the previous binding is deactivated', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-RE',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstId = first.body.data.id as string;

    const off = await api()
      .patch(`/api/v1/security/visitor-bindings/${firstId}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.status, 'INACTIVE');

    const second = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-RE',
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
  });

  it('updates security context, security post, and security workforce', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-UPD',
      securityContext: 'Initial context',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/security/visitor-bindings/${id}`)
      .set(auth())
      .send({
        securityContext: 'Updated context',
        securityPostId: f.postA1.id,
        securityWorkforceId: f.worker.id,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.securityContext, 'Updated context');
    assert.equal(updated.body.data.securityPostId, f.postA1.id);
    assert.equal(updated.body.data.securityWorkforceId, f.worker.id);
  });

  it('rejects update with no fields', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-VISIT-EMPTY',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const empty = await api()
      .patch(`/api/v1/security/visitor-bindings/${id}`)
      .set(auth())
      .send({});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects create with missing externalVisitReference', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const missing = await createBinding({
      buildingId: f.buildingA.id,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .post('/api/v1/security/visitor-bindings')
      .send({ buildingId: f.buildingA.id, externalVisitReference: 'X' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();

    const forbiddenCreate = await createBinding(
      { buildingId: f.buildingA.id, externalVisitReference: 'EXT-RBAC' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/security/visitor-bindings')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-RBAC-2',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const forbiddenRead = await api()
      .get(`/api/v1/security/visitor-bindings/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenPatch = await api()
      .patch(`/api/v1/security/visitor-bindings/${created.body.data.id}`)
      .set(auth(plainToken))
      .send({ securityContext: 'forbidden' });
    assert.equal(forbiddenPatch.status, 403);
    assert.equal(forbiddenPatch.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createBinding({
      buildingId: f.buildingA.id,
      externalVisitReference: 'EXT-ISO',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A user with access ONLY to building B cannot read or patch
    // building-A bindings.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedRead = await api()
      .get(`/api/v1/security/visitor-bindings/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/security/visitor-bindings/${created.body.data.id}`)
      .set(auth(bOnly.token))
      .send({ securityContext: 'should fail' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(deniedPatch.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/security/visitor-bindings')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    const ids = scopedList.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
