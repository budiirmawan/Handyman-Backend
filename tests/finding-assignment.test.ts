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
import { teamService } from '../src/modules/teams';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { vendorService } from '../src/modules/vendors';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE finding_assignments, findings, users, roles, clients CASCADE');
  const admin = await createAdminUser();
  token = admin.token;
  userId = admin.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

async function client() {
  return clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
}
async function building(clientId: string, assignTo: string | null = userId) {
  const property = await propertyService.createProperty({ clientId, code: `P_${suffix()}`, name: 'Property' });
  const result = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  if (assignTo) await buildingAssignmentService.createAssignment(assignTo, { buildingId: result.id });
  return result;
}
async function chain(clientId: string) {
  const organization = await organizationService.createOrganization({ clientId, code: `O_${suffix()}`, name: 'Organization' });
  const department = await departmentService.createDepartment({ organizationId: organization.id, code: `D_${suffix()}`, name: 'Department' });
  const position = await positionService.createPosition({ organizationId: organization.id, code: `P_${suffix()}`, name: 'Position' });
  return { organization, department, position };
}
async function workforce(context: Awaited<ReturnType<typeof chain>>, type: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL') {
  return workforceService.createWorkforceProfile({
    organizationId: context.organization.id,
    departmentId: context.department.id,
    positionId: context.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Worker',
    workforceType: type,
  });
}
async function finding(clientId: string, buildingId: string, reporter = userId) {
  return findingService.createFinding({
    clientId, buildingId, findingNumber: `FND_${suffix()}`, title: 'Finding', reportedByUserId: reporter,
  });
}
async function vendor(clientId: string, buildingId: string, related = true) {
  const item = await vendorService.createVendor({ clientId, vendorCode: `V_${suffix()}`, vendorName: 'Vendor' });
  if (related) await vendorBuildingService.assignBuildingToVendor({ vendorId: item.id, buildingId });
  return item;
}
async function assign(findingId: string, body: object, value = token) {
  return api().post(`/api/v1/findings/${findingId}/assignments`).set(auth(value)).send(body);
}

describe('BE-09D Finding responsible party assignment', () => {
  it('assigns Workforce placed in the Finding Building', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), context = await chain(c.id), worker = await workforce(context);
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: worker.id, buildingId: b.id });
    const item = await finding(c.id, b.id);
    const response = await assign(item.id, { assigneeType: 'WORKFORCE', workforceProfileId: worker.id });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.workforceProfileId, worker.id);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('assigns an active Team from the same Client', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), context = await chain(c.id);
    const team = await teamService.createTeam({ departmentId: context.department.id, code: `T_${suffix()}`, name: 'Team' });
    const item = await finding(c.id, b.id);
    const response = await assign(item.id, { assigneeType: 'TEAM', teamId: team.id });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.teamId, team.id);
  });

  it('assigns a Vendor related to the Finding Building', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), provider = await vendor(c.id, b.id);
    const item = await finding(c.id, b.id);
    const response = await assign(item.id, { assigneeType: 'VENDOR', vendorId: provider.id });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorId, provider.id);
  });

  it('assigns active Vendor Workforce bound to the selected Vendor', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), context = await chain(c.id);
    const provider = await vendor(c.id, b.id), worker = await workforce(context, 'EXTERNAL');
    await vendorWorkforceService.createVendorWorkforceBinding({ vendorId: provider.id, workforceProfileId: worker.id, vendorPersonnelCode: `VP_${suffix()}` });
    const item = await finding(c.id, b.id);
    const response = await assign(item.id, { assigneeType: 'VENDOR_WORKFORCE', vendorId: provider.id, workforceProfileId: worker.id });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.vendorId, provider.id);
    assert.equal(response.body.data.workforceProfileId, worker.id);
  });

  it('rejects unknown, inactive, and Vendor Workforce mismatched assignees', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), item = await finding(c.id, b.id);
    const unknown = await assign(item.id, { assigneeType: 'WORKFORCE', workforceProfileId: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');

    const context = await chain(c.id), inactive = await workforce(context);
    await workforceService.updateWorkforceProfile(inactive.id, { status: 'INACTIVE' });
    const inactiveResponse = await assign(item.id, { assigneeType: 'WORKFORCE', workforceProfileId: inactive.id });
    assert.equal(inactiveResponse.status, 400);
    assert.equal(inactiveResponse.body.error.code, 'WORKFORCE_PROFILE_INACTIVE');

    const provider = await vendor(c.id, b.id), external = await workforce(context, 'EXTERNAL');
    const mismatch = await assign(item.id, { assigneeType: 'VENDOR_WORKFORCE', vendorId: provider.id, workforceProfileId: external.id });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'FINDING_ASSIGNMENT_VENDOR_WORKFORCE_MISMATCH');
  });

  it('rejects duplicate active assignment and supports transactional reassign', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), context = await chain(c.id);
    const firstTeam = await teamService.createTeam({ departmentId: context.department.id, code: `T_${suffix()}`, name: 'First' });
    const secondTeam = await teamService.createTeam({ departmentId: context.department.id, code: `T_${suffix()}`, name: 'Second' });
    const item = await finding(c.id, b.id);
    const first = await assign(item.id, { assigneeType: 'TEAM', teamId: firstTeam.id });
    const duplicate = await assign(item.id, { assigneeType: 'TEAM', teamId: secondTeam.id });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'FINDING_ASSIGNMENT_ALREADY_ASSIGNED');

    const reassigned = await api().patch(`/api/v1/findings/${item.id}/assignments/${first.body.data.id}`).set(auth()).send({ assigneeType: 'TEAM', teamId: secondTeam.id });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.data.teamId, secondTeam.id);
    const current = await api().get(`/api/v1/findings/${item.id}/assignments/current`).set(auth());
    assert.equal(current.body.data.id, reassigned.body.data.id);
    const list = await api().get(`/api/v1/findings/${item.id}/assignments`).set(auth());
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.data[0].status, 'INACTIVE');
    assert.equal(list.body.data[1].status, 'ACTIVE');
  });

  it('deactivates an assignment without deleting history', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), context = await chain(c.id);
    const team = await teamService.createTeam({ departmentId: context.department.id, code: `T_${suffix()}`, name: 'Team' });
    const item = await finding(c.id, b.id), created = await assign(item.id, { assigneeType: 'TEAM', teamId: team.id });
    const response = await api().patch(`/api/v1/findings/${item.id}/assignments/${created.body.data.id}`).set(auth()).send({ status: 'INACTIVE' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'INACTIVE');
    const current = await api().get(`/api/v1/findings/${item.id}/assignments/current`).set(auth());
    assert.equal(current.body.data, null);
  });

  it('rejects cross-Client and cross-Building assignees', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), item = await finding(c.id, b.id);
    const foreignClient = await client(), foreignChain = await chain(foreignClient.id), foreignWorker = await workforce(foreignChain);
    const crossClient = await assign(item.id, { assigneeType: 'WORKFORCE', workforceProfileId: foreignWorker.id });
    assert.equal(crossClient.status, 400);
    assert.equal(crossClient.body.error.code, 'FINDING_ASSIGNMENT_CLIENT_MISMATCH');

    const context = await chain(c.id), worker = await workforce(context), otherBuilding = await building(c.id);
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: worker.id, buildingId: otherBuilding.id });
    const crossBuilding = await assign(item.id, { assigneeType: 'WORKFORCE', workforceProfileId: worker.id });
    assert.equal(crossBuilding.status, 400);
    assert.equal(crossBuilding.body.error.code, 'FINDING_ASSIGNMENT_BUILDING_MISMATCH');
  });

  it('rejects Vendor without the Finding Building relationship', async (t) => {
    if (!ready(t)) return;
    const c = await client(), b = await building(c.id), provider = await vendor(c.id, b.id, false);
    const item = await finding(c.id, b.id);
    const response = await assign(item.id, { assigneeType: 'VENDOR', vendorId: provider.id });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'FINDING_ASSIGNMENT_BUILDING_MISMATCH');
  });

  it('preserves Finding Building isolation and RBAC', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser(), c = await client(), b = await building(c.id, owner.userId), context = await chain(c.id);
    const team = await teamService.createTeam({ departmentId: context.department.id, code: `T_${suffix()}`, name: 'Team' });
    const item = await finding(c.id, b.id, owner.userId);
    const isolated = await assign(item.id, { assigneeType: 'TEAM', teamId: team.id });
    assert.equal(isolated.status, 403);
    assert.equal(isolated.body.error.code, 'BUILDING_ACCESS_DENIED');
    const plain = await createPlainSession();
    const denied = await assign(item.id, { assigneeType: 'TEAM', teamId: team.id }, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});
