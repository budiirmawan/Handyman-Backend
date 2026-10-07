import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { findingService } from '../src/modules/findings';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const WORKFLOW_PERMISSIONS = [
  'finding.read',
  'finding.manage',
  'finding.assign',
  'finding.execute',
  'finding.review',
  'finding.close',
];
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE finding_rework_cycles, reviews, finding_assignments, findings, users, roles, clients CASCADE');
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

async function setWorkflowPermissions(userId: string, active: string[]) {
  await pool!.query(
    `UPDATE role_permission_assignments rpa
     SET status = CASE WHEN p.code = ANY($2::text[]) THEN 'ACTIVE' ELSE 'REVOKED' END,
         updated_at = NOW()
     FROM user_role_assignments ura, permissions p
     WHERE ura.role_id=rpa.role_id AND ura.user_id=$1
       AND p.id=rpa.permission_id AND p.code = ANY($3::text[])`,
    [userId, active, WORKFLOW_PERMISSIONS],
  );
}
async function setPermission(userId: string, code: string, active: boolean) {
  await pool!.query(
    `UPDATE role_permission_assignments rpa
     SET status=$3, updated_at=NOW()
     FROM user_role_assignments ura, permissions p
     WHERE ura.role_id=rpa.role_id AND ura.user_id=$1
       AND p.id=rpa.permission_id AND p.code=$2`,
    [userId, code, active ? 'ACTIVE' : 'REVOKED'],
  );
}
async function fixture() {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(managerUserId, { buildingId: building.id });
  await buildingAssignmentService.createAssignment(worker.userId, { buildingId: building.id });
  const organization = await organizationService.createOrganization({ clientId: client.id, code: `O_${suffix()}`, name: 'Organization' });
  const department = await departmentService.createDepartment({ organizationId: organization.id, code: `D_${suffix()}`, name: 'Department' });
  const position = await positionService.createPosition({ organizationId: organization.id, code: `P_${suffix()}`, name: 'Position' });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: profile.id, buildingId: building.id });
  const finding = await findingService.createFinding({ clientId: client.id, buildingId: building.id, findingNumber: `FND_${suffix()}`, title: 'Authority finding', reportedByUserId: managerUserId });
  return { worker, client, building, profile, finding };
}
async function actions(findingId: string, token: string) {
  return api().get(`/api/v1/findings/${findingId}/available-actions`).set(auth(token));
}
async function transition(findingId: string, state: string, token = managerToken) {
  const response = await api().patch(`/api/v1/findings/${findingId}/state`).set(auth(token)).send({ state });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
async function managerAssign(item: Awaited<ReturnType<typeof fixture>>) {
  const response = await api().post(`/api/v1/findings/${item.finding.id}/assignments`).set(auth()).send({ assigneeType: 'WORKFORCE', workforceProfileId: item.profile.id });
  assert.equal(response.status, 201);
}

describe('BE-09J Finding workflow authority and permission binding', () => {
  it('keeps ASSIGN resolver visibility consistent with assignment endpoint permission', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    const assigner = await createAdminUser();
    await buildingAssignmentService.createAssignment(assigner.userId, { buildingId: item.building.id });
    await setWorkflowPermissions(assigner.userId, ['finding.read', 'finding.assign']);
    const available = await actions(item.finding.id, assigner.token);
    assert.deepEqual(available.body.data.availableActions, ['ASSIGN']);
    const assigned = await api().post(`/api/v1/findings/${item.finding.id}/assignments`).set(auth(assigner.token)).send({ assigneeType: 'WORKFORCE', workforceProfileId: item.profile.id });
    assert.equal(assigned.status, 201);

    const denied = await createAdminUser();
    await buildingAssignmentService.createAssignment(denied.userId, { buildingId: item.building.id });
    await setWorkflowPermissions(denied.userId, ['finding.read']);
    assert.deepEqual((await actions(item.finding.id, denied.token)).body.data.availableActions, []);
    const endpoint = await api().post(`/api/v1/findings/${item.finding.id}/assignments`).set(auth(denied.token)).send({ assigneeType: 'WORKFORCE', workforceProfileId: item.profile.id });
    assert.equal(endpoint.status, 403);
  });

  it('enforces assignee identity and finding.execute for START at resolver and endpoint', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await managerAssign(item);
    await transition(item.finding.id, 'ASSIGNED');
    await setWorkflowPermissions(item.worker.userId, ['finding.read', 'finding.execute']);
    assert.deepEqual((await actions(item.finding.id, item.worker.token)).body.data.availableActions, ['START']);

    const outsider = await createAdminUser();
    await buildingAssignmentService.createAssignment(outsider.userId, { buildingId: item.building.id });
    await setWorkflowPermissions(outsider.userId, ['finding.read', 'finding.execute']);
    assert.deepEqual((await actions(item.finding.id, outsider.token)).body.data.availableActions, []);
    const denied = await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth(outsider.token)).send({ state: 'IN_PROGRESS' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');

    const started = await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth(item.worker.token)).send({ state: 'IN_PROGRESS' });
    assert.equal(started.status, 200);
  });

  it('binds reviewer and closer permissions to both available actions and endpoints', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await managerAssign(item);
    await transition(item.finding.id, 'ASSIGNED');
    await transition(item.finding.id, 'IN_PROGRESS', item.worker.token);
    await transition(item.finding.id, 'PENDING_REVIEW', item.worker.token);

    const reviewer = await createAdminUser();
    await buildingAssignmentService.createAssignment(reviewer.userId, { buildingId: item.building.id });
    await setWorkflowPermissions(reviewer.userId, ['finding.read', 'finding.review']);
    assert.deepEqual((await actions(item.finding.id, reviewer.token)).body.data.availableActions, ['OPEN_REVIEW']);
    assert.equal((await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth(reviewer.token)).send({})).status, 201);
    assert.deepEqual((await actions(item.finding.id, reviewer.token)).body.data.availableActions, ['APPROVE', 'REJECT', 'REQUEST_REWORK']);
    assert.equal((await api().post(`/api/v1/findings/${item.finding.id}/verification`).set(auth(reviewer.token)).send({ decision: 'APPROVED' })).status, 201);

    const closer = await createAdminUser();
    await buildingAssignmentService.createAssignment(closer.userId, { buildingId: item.building.id });
    await setWorkflowPermissions(closer.userId, ['finding.read', 'finding.close']);
    assert.deepEqual((await actions(item.finding.id, closer.token)).body.data.availableActions, ['CLOSE']);
    assert.equal((await api().post(`/api/v1/findings/${item.finding.id}/close`).set(auth(closer.token)).send({})).status, 200);
  });

  it('reflects permission changes immediately in actions and endpoint authorization', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await managerAssign(item);
    await transition(item.finding.id, 'ASSIGNED');
    await setWorkflowPermissions(item.worker.userId, ['finding.read', 'finding.execute']);
    assert.deepEqual((await actions(item.finding.id, item.worker.token)).body.data.availableActions, ['START']);

    await setPermission(item.worker.userId, 'finding.execute', false);
    assert.deepEqual((await actions(item.finding.id, item.worker.token)).body.data.availableActions, []);
    const denied = await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth(item.worker.token)).send({ state: 'IN_PROGRESS' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');

    await setPermission(item.worker.userId, 'finding.execute', true);
    assert.deepEqual((await actions(item.finding.id, item.worker.token)).body.data.availableActions, ['START']);
    assert.equal((await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth(item.worker.token)).send({ state: 'IN_PROGRESS' })).status, 200);
  });
});
