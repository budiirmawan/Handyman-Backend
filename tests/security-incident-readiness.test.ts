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
import { teamService } from '../src/modules/teams';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { api } from './helpers/http';
import { createAdminUser, createPlainSession } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-12I — Security Incident Readiness focused validation.
 *
 * Covers: create / get / list / patch / activate-deactivate, every
 * readiness status (READY / PARTIAL / NOT_READY), invalid category
 * rejected, invalid Security Post / Workforce / Team context rejected,
 * Security Post / Building mismatch rejected, cross-Client rejection,
 * cross-Building rejection, RBAC, and Building isolation.
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
    name: 'Security Readiness client',
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

  // Security Posts in building A.
  const postA1 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby A', postType: 'LOBBY' })
  ).body.data;
  const postA2 = (
    await api()
      .post(`/api/v1/buildings/${buildingA.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Gate A', postType: 'GATE' })
  ).body.data;

  // Security Posts in building B.
  const postB = (
    await api()
      .post(`/api/v1/buildings/${buildingB.id}/security-posts`)
      .set(auth())
      .send({ code: `SP_${suffix()}`, name: 'Lobby B', postType: 'LOBBY' })
  ).body.data;

  // Workforce for responsible_workforce_id.
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
    name: 'Security lead',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `T_${suffix()}`,
    name: 'Security team',
  });
  const worker = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Security lead',
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
    postA2,
    postB,
    organization,
    department,
    position,
    team,
    worker,
  };
}

async function createReadiness(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/security/incident-readiness')
    .set(auth(token))
    .send(body);
}

describe('BE-12I security incident readiness', () => {
  it('creates a readiness configuration for a building (no post)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
      readinessStatus: 'READY',
      escalationContact: '+1-555-0100',
      reportingInstructions: 'Call 911 then notify the SOC.',
      responsibleTeamId: f.team.id,
      responsibleWorkforceId: f.worker.id,
      notes: 'Front desk readiness.',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.securityPostId, null);
    assert.equal(data.category, 'SECURITY');
    assert.equal(data.readinessStatus, 'READY');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.responsibleTeamId, f.team.id);
    assert.equal(data.responsibleWorkforceId, f.worker.id);
    assert.equal(data.escalationContact, '+1-555-0100');
    assert.equal(data.reportingInstructions, 'Call 911 then notify the SOC.');
    assert.equal(data.notes, 'Front desk readiness.');
    assert.equal(data.effectiveReadiness, 'READY');
    assert.deepEqual(data.effectiveReasons, []);
  });

  it('creates a readiness configuration for a specific post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'FIRE',
      readinessStatus: 'PARTIAL',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.securityPostId, f.postA1.id);
    assert.equal(data.category, 'FIRE');
    assert.equal(data.readinessStatus, 'PARTIAL');
    assert.equal(data.effectiveReadiness, 'PARTIAL');
  });

  it('rejects invalid category', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'NOT_A_REAL_CATEGORY',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects invalid readiness status', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
      readinessStatus: 'MAYBE',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects unknown building, post, team, workforce, evidence_requirement', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unknownBuilding = await createReadiness({
      buildingId: randomUUID(),
      category: 'SECURITY',
    });
    assert.equal(unknownBuilding.status, 404);
    assert.equal(unknownBuilding.body.error.code, 'BUILDING_NOT_FOUND');

    const unknownPost = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: randomUUID(),
      category: 'SECURITY',
    });
    assert.equal(unknownPost.status, 404);

    const unknownTeam = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
      responsibleTeamId: randomUUID(),
    });
    assert.equal(unknownTeam.status, 404);

    const unknownWorkforce = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SAFETY',
      responsibleWorkforceId: randomUUID(),
    });
    assert.equal(unknownWorkforce.status, 404);
  });

  it('rejects security post / building mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postB.id, // post belongs to building B
      category: 'SECURITY',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_INCIDENT_READINESS_SECURITY_POST_BUILDING_MISMATCH',
    );
  });

  it('rejects INACTIVE security post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Deactivate postA1.
    const off = await api()
      .patch(`/api/v1/security/posts/${f.postA1.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200, JSON.stringify(off.body));

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_INCIDENT_READINESS_SECURITY_POST_INACTIVE',
    );
  });

  it('rejects cross-Client team / workforce', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Build a foreign-Client team + workforce directly via SQL.
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
    const foreignTeamRes = await pool!.query<{ id: string }>(
      `INSERT INTO teams (id, department_id, code, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
      [randomUUID(), foreignDeptId, `TF_${suffix()}`, 'Foreign team'],
    );
    const foreignTeamId = foreignTeamRes.rows[0].id;
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

    const crossTeam = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
      responsibleTeamId: foreignTeamId,
    });
    assert.equal(crossTeam.status, 404);

    const crossWorker = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SAFETY',
      responsibleWorkforceId: foreignWorkerId,
    });
    assert.equal(crossWorker.status, 404);
  });

  it('rejects workforce without an active building assignment', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Build a second workforce without any building assignment.
    const secondWorker = await workforceService.createWorkforceProfile({
      organizationId: f.organization.id,
      departmentId: f.department.id,
      positionId: f.position.id,
      employeeCode: `WF2_${suffix()}`,
      fullName: 'Unassigned worker',
    });

    const response = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
      responsibleWorkforceId: secondWorker.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_INCIDENT_READINESS_WORKFORCE_BUILDING_MISMATCH',
    );
  });

  it('rejects duplicate ACTIVE readiness for the same (post, category)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'SECURITY_INCIDENT_READINESS_ALREADY_EXISTS',
    );
  });

  it('evaluates NOT_READY → PARTIAL → READY states deterministically', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Create the readiness while the post is still ACTIVE and the
    // workforce has an active building assignment.
    const created = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'MEDICAL',
      readinessStatus: 'READY',
      responsibleWorkforceId: f.worker.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Operator wrote READY, all references are ACTIVE → effective READY.
    assert.equal(created.body.data.effectiveReadiness, 'READY');
    assert.deepEqual(created.body.data.effectiveReasons, []);

    // Deactivate the post → effective downgrades to PARTIAL.
    const off = await api()
      .patch(`/api/v1/security/posts/${f.postA1.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200, JSON.stringify(off.body));

    const afterPost = await api()
      .get(
        `/api/v1/security/incident-readiness/${created.body.data.id}`,
      )
      .set(auth());
    assert.equal(afterPost.status, 200, JSON.stringify(afterPost.body));
    assert.equal(afterPost.body.data.effectiveReadiness, 'PARTIAL');
    assert.equal(afterPost.body.data.effectiveReasons.length, 1);

    // Deactivate the workforce assignment as well to push to NOT_READY.
    const wbaRes = await pool!.query<{ id: string }>(
      `SELECT id FROM workforce_building_assignments
       WHERE workforce_profile_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
      [f.worker.id, f.buildingA.id],
    );
    if (wbaRes.rows[0]) {
      await pool!.query(
        `UPDATE workforce_building_assignments SET status = 'INACTIVE'
         WHERE id = $1`,
        [wbaRes.rows[0].id],
      );
    }
    const reget = await api()
      .get(
        `/api/v1/security/incident-readiness/${created.body.data.id}`,
      )
      .set(auth());
    assert.equal(reget.status, 200, JSON.stringify(reget.body));
    assert.equal(reget.body.data.effectiveReadiness, 'NOT_READY');
    assert.ok(reget.body.data.effectiveReasons.length >= 2);
  });

  it('GETs by id and LISTs with filters', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const a1 = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
      readinessStatus: 'READY',
    });
    assert.equal(a1.status, 201, JSON.stringify(a1.body));
    const id = a1.body.data.id as string;

    const a2 = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA2.id,
      category: 'ACCESS',
      readinessStatus: 'NOT_READY',
    });
    assert.equal(a2.status, 201, JSON.stringify(a2.body));

    const byId = await api()
      .get(`/api/v1/security/incident-readiness/${id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, id);

    const byBuilding = await api()
      .get('/api/v1/security/incident-readiness')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(byBuilding.status, 200, JSON.stringify(byBuilding.body));
    const ids = byBuilding.body.data.map((x: { id: string }) => x.id);
    assert.ok(ids.includes(id));
    assert.ok(ids.includes(a2.body.data.id));

    const byPost = await api()
      .get('/api/v1/security/incident-readiness')
      .query({ securityPostId: f.postA1.id })
      .set(auth());
    assert.equal(byPost.status, 200, JSON.stringify(byPost.body));
    assert.ok(
      byPost.body.data.some((x: { id: string }) => x.id === id),
    );
    assert.equal(byPost.body.data.length, 1);

    const byCategory = await api()
      .get('/api/v1/security/incident-readiness')
      .query({ category: 'SECURITY' })
      .set(auth());
    assert.equal(byCategory.status, 200, JSON.stringify(byCategory.body));
    assert.ok(
      byCategory.body.data.some((x: { id: string }) => x.id === id),
    );

    const byReadiness = await api()
      .get('/api/v1/security/incident-readiness')
      .query({ readinessStatus: 'NOT_READY' })
      .set(auth());
    assert.equal(byReadiness.status, 200, JSON.stringify(byReadiness.body));
    assert.ok(
      byReadiness.body.data.some(
        (x: { id: string }) => x.id === a2.body.data.id,
      ),
    );
  });

  it('activates and deactivates a readiness row', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    // Deactivate.
    const off = await api()
      .patch(`/api/v1/security/incident-readiness/${id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.data.status, 'INACTIVE');
    // While INACTIVE the post is no longer the one flagged as a reason —
    // the row's own status is the only reason, so effective is NOT_READY.
    assert.equal(off.body.data.effectiveReadiness, 'NOT_READY');

    // A second ACTIVE readiness for the same (post, category) is now allowed.
    const replacement = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));

    // Reactivating the first one is rejected (duplicate ACTIVE).
    const reReactivate = await api()
      .patch(`/api/v1/security/incident-readiness/${id}`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(reReactivate.status, 409);
    assert.equal(
      reReactivate.body.error.code,
      'SECURITY_INCIDENT_READINESS_ALREADY_EXISTS',
    );
  });

  it('updates readinessStatus, notes, escalationContact', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createReadiness({
      buildingId: f.buildingA.id,
      securityPostId: f.postA1.id,
      category: 'SECURITY',
      readinessStatus: 'PARTIAL',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/security/incident-readiness/${id}`)
      .set(auth())
      .send({
        readinessStatus: 'READY',
        notes: 'Updated notes',
        escalationContact: '+1-555-0199',
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.readinessStatus, 'READY');
    assert.equal(updated.body.data.notes, 'Updated notes');
    assert.equal(updated.body.data.escalationContact, '+1-555-0199');
  });

  it('rejects update with no fields', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const empty = await api()
      .patch(`/api/v1/security/incident-readiness/${id}`)
      .set(auth())
      .send({});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .post('/api/v1/security/incident-readiness')
      .send({ buildingId: f.buildingA.id, category: 'SECURITY' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();

    const forbiddenCreate = await createReadiness(
      { buildingId: f.buildingA.id, category: 'SECURITY' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(forbiddenCreate.body.error.code, 'PERMISSION_DENIED');

    const forbiddenList = await api()
      .get('/api/v1/security/incident-readiness')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const forbiddenRead = await api()
      .get(`/api/v1/security/incident-readiness/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenPatch = await api()
      .patch(`/api/v1/security/incident-readiness/${created.body.data.id}`)
      .set(auth(plainToken))
      .send({ notes: 'forbidden' });
    assert.equal(forbiddenPatch.status, 403);
    assert.equal(forbiddenPatch.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createReadiness({
      buildingId: f.buildingA.id,
      category: 'SECURITY',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A user with access ONLY to building B cannot read or patch
    // building-A readiness.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedRead = await api()
      .get(`/api/v1/security/incident-readiness/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'BUILDING_ACCESS_DENIED');

    const deniedPatch = await api()
      .patch(`/api/v1/security/incident-readiness/${created.body.data.id}`)
      .set(auth(bOnly.token))
      .send({ notes: 'should fail' });
    assert.equal(deniedPatch.status, 403);
    assert.equal(deniedPatch.body.error.code, 'BUILDING_ACCESS_DENIED');

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/security/incident-readiness')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    const ids = scopedList.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
