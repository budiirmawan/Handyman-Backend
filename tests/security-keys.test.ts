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
 * BE-12K — Security Key Control focused validation.
 *
 * Covers:
 *  - create / list / get / patch
 *  - issue AVAILABLE key → custody row appended
 *  - current custody resolution
 *  - return issued key → custody row appended; status flips to AVAILABLE
 *  - custody history preserved (append-only)
 *  - duplicate issue rejected (key already ISSUED)
 *  - return without an open issue rejected
 *  - mark LOST; LOST key cannot be re-issued
 *  - invalid Workforce / cross-Building / cross-Client rejected
 *  - Functional Location / Building mismatch rejected
 *  - Security Post / Building mismatch rejected
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
       security_key_custody, security_keys,
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
    name: 'Security Key client',
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

async function createKey(
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post('/api/v1/security/keys')
    .set(auth(token))
    .send(body);
}

async function issueKey(
  keyId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/keys/${keyId}/issue`)
    .set(auth(token))
    .send(body);
}

async function returnKey(
  keyId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/keys/${keyId}/return`)
    .set(auth(token))
    .send(body);
}

async function markLost(
  keyId: string,
  body: Record<string, unknown>,
  token = managerToken,
) {
  return api()
    .post(`/api/v1/security/keys/${keyId}/mark-lost`)
    .set(auth(token))
    .send(body);
}

describe('BE-12K security key control', () => {
  it('creates a controlled key with anchors and lists / gets it', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-A-001',
      name: 'Master A',
      description: 'Main building master key.',
      securityPostId: f.postA1.id,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const data = response.body.data;

    assert.equal(data.buildingId, f.buildingA.id);
    assert.equal(data.clientId, f.clientA.id);
    assert.equal(data.code, 'KEY-A-001');
    assert.equal(data.name, 'Master A');
    assert.equal(data.description, 'Main building master key.');
    assert.equal(data.securityPostId, f.postA1.id);
    assert.equal(data.functionalLocationId, null);
    assert.equal(data.status, 'AVAILABLE');
    assert.equal(data.createdByUserId, managerUserId);
    assert.ok(data.createdAt);
    assert.ok(data.updatedAt);

    const id = data.id as string;

    const byId = await api()
      .get(`/api/v1/security/keys/${id}`)
      .set(auth());
    assert.equal(byId.status, 200, JSON.stringify(byId.body));
    assert.equal(byId.body.data.id, id);

    const list = await api()
      .get('/api/v1/security/keys')
      .query({ buildingId: f.buildingA.id })
      .set(auth());
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(
      list.body.data.some((x: { id: string }) => x.id === id),
    );

    const byStatus = await api()
      .get('/api/v1/security/keys')
      .query({ status: 'AVAILABLE' })
      .set(auth());
    assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
    assert.ok(
      byStatus.body.data.some((x: { id: string }) => x.id === id),
    );

    const byPost = await api()
      .get('/api/v1/security/keys')
      .query({ securityPostId: f.postA1.id })
      .set(auth());
    assert.equal(byPost.status, 200, JSON.stringify(byPost.body));
    assert.ok(
      byPost.body.data.some((x: { id: string }) => x.id === id),
    );
  });

  it('rejects duplicate (building, code)', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const first = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-A-DUP',
      name: 'Dup',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const dup = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-A-DUP',
      name: 'Dup 2',
    });
    assert.equal(dup.status, 409);
    assert.equal(
      dup.body.error.code,
      'SECURITY_KEY_CODE_ALREADY_EXISTS',
    );
  });

  it('rejects cross-Building Security Post', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-XB',
      name: 'Cross building post',
      securityPostId: f.postB.id, // post is in building B
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_KEY_SECURITY_POST_BUILDING_MISMATCH',
    );
  });

  it('rejects Functional Location / Building mismatch', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // Create a functional location in building B.
    const flB = await api()
      .post(`/api/v1/buildings/${f.buildingB.id}/functional-locations`)
      .set(auth())
      .send({ code: `FL_${suffix()}`, name: 'B room' });
    assert.equal(flB.status, 201, JSON.stringify(flB.body));

    const response = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-FL-XB',
      name: 'Cross building location',
      functionalLocationId: flB.body.data.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_KEY_FUNCTIONAL_LOCATION_BUILDING_MISMATCH',
    );
  });

  it('issues an AVAILABLE key and resolves the current custody', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-ISSUE',
      name: 'Issuable key',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const issue = await issueKey(id, {
      issuedToWorkforceId: f.worker.id,
      notes: 'Issued to front-desk guard',
      expectedReturnAt: new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    assert.equal(issue.status, 201, JSON.stringify(issue.body));
    assert.equal(issue.body.data.status, 'ISSUED');

    // The Key's status flips to ISSUED.
    const afterIssue = await api()
      .get(`/api/v1/security/keys/${id}`)
      .set(auth());
    assert.equal(afterIssue.status, 200, JSON.stringify(afterIssue.body));
    assert.equal(afterIssue.body.data.status, 'ISSUED');

    // The current custody endpoint returns the open ISSUE row.
    const custody = await api()
      .get(`/api/v1/security/keys/${id}/custody`)
      .set(auth());
    assert.equal(custody.status, 200, JSON.stringify(custody.body));
    assert.equal(custody.body.data.transactionType, 'ISSUE');
    assert.equal(custody.body.data.issuedToWorkforceId, f.worker.id);
    assert.equal(custody.body.data.returnedAt, null);
    assert.ok(custody.body.data.issuedAt);
  });

  it('rejects issuing a key that is not AVAILABLE', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-INACTIVE-ISSUE',
      name: 'Inactive key',
      status: 'INACTIVE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const response = await issueKey(id, {
      issuedToWorkforceId: f.worker.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_KEY_NOT_AVAILABLE',
    );
  });

  it('rejects duplicate issue while the key is already ISSUED', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-DUP-ISSUE',
      name: 'Duplicate issue',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const first = await issueKey(id, { issuedToWorkforceId: f.worker.id });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await issueKey(id, { issuedToWorkforceId: f.worker.id });
    assert.equal(second.status, 409);
    assert.equal(
      second.body.error.code,
      'SECURITY_KEY_ALREADY_ISSUED',
    );
  });

  it('returns an issued key, appends custody history, and resets to AVAILABLE', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-RETURN',
      name: 'Returnable key',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    await issueKey(id, { issuedToWorkforceId: f.worker.id });
    const returned = await returnKey(id, {
      returnedToUserId: managerUserId,
      notes: 'Returned to manager',
    });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.data.status, 'AVAILABLE');

    // The Key flips back to AVAILABLE.
    const afterReturn = await api()
      .get(`/api/v1/security/keys/${id}`)
      .set(auth());
    assert.equal(afterReturn.status, 200, JSON.stringify(afterReturn.body));
    assert.equal(afterReturn.body.data.status, 'AVAILABLE');

    // Current custody is null (no open issue).
    const custody = await api()
      .get(`/api/v1/security/keys/${id}/custody`)
      .set(auth());
    assert.equal(custody.status, 200, JSON.stringify(custody.body));
    assert.equal(custody.body.data, null);

    // Custody history contains both rows in chronological order.
    const history = await api()
      .get(`/api/v1/security/keys/${id}/history`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 2);
    assert.equal(history.body.data[0].transactionType, 'ISSUE');
    assert.equal(history.body.data[0].issuedToWorkforceId, f.worker.id);
    // The open ISSUE row is "closed" by the RETURN — its return-side
    // fields are populated. The historical issue fields (issued_at,
    // issued_by, issued_to) are preserved.
    assert.ok(history.body.data[0].returnedAt);
    assert.equal(
      history.body.data[0].returnedToUserId,
      managerUserId,
    );
    assert.equal(history.body.data[1].transactionType, 'RETURN');
    assert.equal(history.body.data[1].returnedToUserId, managerUserId);
    assert.ok(history.body.data[1].returnedAt);
  });

  it('rejects a duplicate return when no issue is open', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-DUP-RETURN',
      name: 'Duplicate return',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    // No prior issue.
    const response = await returnKey(id, {
      returnedToUserId: managerUserId,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SECURITY_KEY_NOT_ISSUED',
    );
  });

  it('preserves custody history across multiple issue / return cycles', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-CYCLE',
      name: 'Cycling key',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    await issueKey(id, { issuedToWorkforceId: f.worker.id });
    await returnKey(id, { returnedToUserId: managerUserId });
    await issueKey(id, { issuedToWorkforceId: f.worker.id });
    await returnKey(id, { returnedToUserId: managerUserId });

    const history = await api()
      .get(`/api/v1/security/keys/${id}/history`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 4);
    const types = history.body.data.map(
      (x: { transactionType: string }) => x.transactionType,
    );
    assert.deepEqual(types, ['ISSUE', 'RETURN', 'ISSUE', 'RETURN']);

    // No open custody — the final state is AVAILABLE.
    const finalKey = await api()
      .get(`/api/v1/security/keys/${id}`)
      .set(auth());
    assert.equal(finalKey.body.data.status, 'AVAILABLE');
    const custody = await api()
      .get(`/api/v1/security/keys/${id}/custody`)
      .set(auth());
    assert.equal(custody.body.data, null);
  });

  it('marks a key LOST and rejects subsequent issue', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-LOST',
      name: 'Lost key',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const lost = await markLost(id, { notes: 'Lost during shift change' });
    assert.equal(lost.status, 200, JSON.stringify(lost.body));
    assert.equal(lost.body.data.status, 'LOST');

    // A LOST key cannot be issued through the normal flow.
    const issue = await issueKey(id, { issuedToWorkforceId: f.worker.id });
    assert.equal(issue.status, 400);
    assert.equal(
      issue.body.error.code,
      'SECURITY_KEY_LOST_CANNOT_BE_ISSUED',
    );

    // A LOST key cannot be returned either.
    const returned = await returnKey(id, {
      returnedToUserId: managerUserId,
    });
    assert.equal(returned.status, 400);
    assert.equal(
      returned.body.error.code,
      'SECURITY_KEY_NOT_ISSUED',
    );

    // Custody history records the MARK_LOST event.
    const history = await api()
      .get(`/api/v1/security/keys/${id}/history`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const types = history.body.data.map(
      (x: { transactionType: string }) => x.transactionType,
    );
    assert.ok(types.includes('MARK_LOST'));
  });

  it('rejects issue to an unknown or cross-Client Workforce', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-WF',
      name: 'Workforce test key',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const unknownWorkforce = await issueKey(id, {
      issuedToWorkforceId: randomUUID(),
    });
    assert.equal(unknownWorkforce.status, 404);

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

    const crossClient = await issueKey(id, {
      issuedToWorkforceId: foreignWorkerId,
    });
    assert.equal(crossClient.status, 400);
    assert.equal(
      crossClient.body.error.code,
      'SECURITY_KEY_WORKFORCE_BUILDING_MISMATCH',
    );

    // A workforce without an active building assignment is rejected.
    const secondWorker = await workforceService.createWorkforceProfile({
      organizationId: f.organization.id,
      departmentId: f.department.id,
      positionId: f.position.id,
      employeeCode: `WF2_${suffix()}`,
      fullName: 'Unassigned worker',
    });
    const noBuilding = await issueKey(id, {
      issuedToWorkforceId: secondWorker.id,
    });
    assert.equal(noBuilding.status, 400);
    assert.equal(
      noBuilding.body.error.code,
      'SECURITY_KEY_WORKFORCE_BUILDING_MISMATCH',
    );
  });

  it('patches name and description and rejects update with no fields', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-PATCH',
      name: 'Patch me',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/security/keys/${id}`)
      .set(auth())
      .send({ name: 'Patched name', description: 'Patched description' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.name, 'Patched name');
    assert.equal(updated.body.data.description, 'Patched description');

    const empty = await api()
      .patch(`/api/v1/security/keys/${id}`)
      .set(auth())
      .send({});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
  });

  it('enforces RBAC on every endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const unauth = await api()
      .post('/api/v1/security/keys')
      .send({ buildingId: f.buildingA.id, code: 'KEY-RBAC', name: 'RBAC' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.error.code, 'AUTHENTICATION_REQUIRED');

    const plainToken = await createPlainSession();

    const forbiddenCreate = await createKey(
      { buildingId: f.buildingA.id, code: 'KEY-RBAC', name: 'RBAC' },
      plainToken,
    );
    assert.equal(forbiddenCreate.status, 403);
    assert.equal(
      forbiddenCreate.body.error.code,
      'PERMISSION_DENIED',
    );

    const forbiddenList = await api()
      .get('/api/v1/security/keys')
      .set(auth(plainToken));
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.body.error.code, 'PERMISSION_DENIED');

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-RBAC',
      name: 'RBAC',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const forbiddenRead = await api()
      .get(`/api/v1/security/keys/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(forbiddenRead.status, 403);
    assert.equal(forbiddenRead.body.error.code, 'PERMISSION_DENIED');

    const forbiddenIssue = await issueKey(
      created.body.data.id,
      { issuedToWorkforceId: f.worker.id },
      plainToken,
    );
    assert.equal(forbiddenIssue.status, 403);
    assert.equal(
      forbiddenIssue.body.error.code,
      'PERMISSION_DENIED',
    );
  });

  it('enforces Building isolation', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const created = await createKey({
      buildingId: f.buildingA.id,
      code: 'KEY-ISO',
      name: 'Isolation',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A user with access ONLY to building B cannot read, issue,
    // return, or mark the building-A key.
    const bOnly = await createAdminUser();
    await buildingAssignmentService.createAssignment(bOnly.userId, {
      buildingId: f.buildingB.id,
    });

    const deniedRead = await api()
      .get(`/api/v1/security/keys/${created.body.data.id}`)
      .set(auth(bOnly.token));
    assert.equal(deniedRead.status, 403);
    assert.equal(
      deniedRead.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedIssue = await issueKey(
      created.body.data.id,
      { issuedToWorkforceId: f.worker.id },
      bOnly.token,
    );
    assert.equal(deniedIssue.status, 403);
    assert.equal(
      deniedIssue.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedReturn = await returnKey(
      created.body.data.id,
      { returnedToUserId: bOnly.userId },
      bOnly.token,
    );
    assert.equal(deniedReturn.status, 403);
    assert.equal(
      deniedReturn.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    const deniedMarkLost = await markLost(
      created.body.data.id,
      {},
      bOnly.token,
    );
    assert.equal(deniedMarkLost.status, 403);
    assert.equal(
      deniedMarkLost.body.error.code,
      'BUILDING_ACCESS_DENIED',
    );

    // An unfiltered list is scoped to the caller's accessible buildings.
    const scopedList = await api()
      .get('/api/v1/security/keys')
      .set(auth(bOnly.token));
    assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
    const ids = scopedList.body.data.map((x: { id: string }) => x.id);
    assert.ok(!ids.includes(created.body.data.id));
  });
});
