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
import { propertyService } from '../src/modules/properties';
import { positionService } from '../src/modules/positions';
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
  await pool.query('TRUNCATE reviews, finding_assignments, findings, users, roles, clients CASCADE');
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

async function pendingFinding(ownerId = userId, ownerToken = token) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(ownerId, { buildingId: building.id });
  await buildingAssignmentService.createAssignment(worker.userId, { buildingId: building.id });
  const organization = await organizationService.createOrganization({ clientId: client.id, code: `O_${suffix()}`, name: 'Organization' });
  const department = await departmentService.createDepartment({ organizationId: organization.id, code: `D_${suffix()}`, name: 'Department' });
  const position = await positionService.createPosition({ organizationId: organization.id, code: `POS_${suffix()}`, name: 'Position' });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Responsible worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: profile.id, buildingId: building.id });
  const finding = await findingService.createFinding({
    clientId: client.id,
    buildingId: building.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Review finding',
    reportedByUserId: ownerId,
  });
  const assigned = await api().post(`/api/v1/findings/${finding.id}/assignments`).set(auth(ownerToken)).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(assigned.status, 201);
  for (const state of ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW']) {
    const actorToken = state === 'ASSIGNED' ? ownerToken : worker.token;
    const response = await api().patch(`/api/v1/findings/${finding.id}/state`).set(auth(actorToken)).send({ state });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  return { client, building, finding, profile };
}
async function open(findingId: string, value = token, notes = 'Ready for review') {
  return api().post(`/api/v1/findings/${findingId}/reviews`).set(auth(value)).send({ notes });
}
async function verify(findingId: string, decision: string, value = token, notes = 'Verification notes') {
  return api().post(`/api/v1/findings/${findingId}/verification`).set(auth(value)).send({ decision, notes });
}

describe('BE-09F Finding review and verification', () => {
  it('creates and resolves the current review for a PENDING_REVIEW Finding', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    const created = await open(item.finding.id);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'PENDING');
    assert.equal(created.body.data.decision, null);
    assert.equal(created.body.data.reviewerUserId, userId);

    const current = await api().get(`/api/v1/findings/${item.finding.id}/reviews/current`).set(auth());
    assert.equal(current.status, 200);
    assert.equal(current.body.data.id, created.body.data.id);
    const list = await api().get(`/api/v1/findings/${item.finding.id}/reviews`).set(auth());
    assert.equal(list.body.data.length, 1);
  });

  it('records APPROVED and transitions the Finding to VERIFIED', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id);
    const response = await verify(item.finding.id, 'APPROVED', token, 'Verified');
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'APPROVED');
    assert.equal(response.body.data.verification.status, 'COMPLETED');
    assert.equal(response.body.data.state, 'VERIFIED');
  });

  it('records REJECTED without implementing reject workflow details', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id);
    const response = await verify(item.finding.id, 'REJECTED');
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'REJECTED');
    assert.equal(response.body.data.state, 'PENDING_REVIEW');
  });

  it('records REWORK_REQUIRED without implementing rework workflow details', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id);
    const response = await verify(item.finding.id, 'REWORK_REQUIRED');
    assert.equal(response.status, 201);
    assert.equal(response.body.data.verification.decision, 'REWORK_REQUIRED');
    assert.equal(response.body.data.state, 'PENDING_REVIEW');
  });

  it('rejects an invalid verification decision', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id);
    const response = await verify(item.finding.id, 'INVALID');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects review creation for a non-reviewable Finding', async (t) => {
    if (!ready(t)) return;
    const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
    const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
    const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
    await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
    const finding = await findingService.createFinding({ clientId: client.id, buildingId: building.id, findingNumber: `FND_${suffix()}`, title: 'Open', reportedByUserId: userId });
    const response = await open(finding.id);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('rejects a verification submitted by a different reviewer', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id);
    const other = await createAdminUser();
    await buildingAssignmentService.createAssignment(other.userId, { buildingId: item.building.id });
    const response = await verify(item.finding.id, 'APPROVED', other.token);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('does not silently overwrite a completed verification', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id);
    assert.equal((await verify(item.finding.id, 'REJECTED')).status, 201);
    const repeated = await verify(item.finding.id, 'APPROVED');
    assert.equal(repeated.status, 403);
    assert.equal(repeated.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('resolves the latest verification while preserving previous reviews', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await open(item.finding.id, token, 'First review');
    await verify(item.finding.id, 'REJECTED', token, 'First result');
    await open(item.finding.id, token, 'Second review');
    await verify(item.finding.id, 'APPROVED', token, 'Final result');

    const response = await api().get(`/api/v1/findings/${item.finding.id}/verification`).set(auth());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.state, 'VERIFIED');
    assert.equal(response.body.data.currentReview, null);
    assert.equal(response.body.data.latestVerification.decision, 'APPROVED');
    assert.equal(response.body.data.reviews.length, 2);
    assert.equal(response.body.data.reviews[0].decision, 'REJECTED');
  });

  it('preserves Client/Building isolation and Finding RBAC', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const item = await pendingFinding(owner.userId, owner.token);
    const isolated = await open(item.finding.id);
    assert.equal(isolated.status, 403);
    assert.equal(isolated.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const denied = await open(item.finding.id, plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});
