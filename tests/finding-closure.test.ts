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
  await pool.query('TRUNCATE finding_rework_cycles, reviews, finding_assignments, findings, users, roles, clients CASCADE');
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

async function pendingFinding(owner = { userId, token }) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(owner.userId, { buildingId: building.id });
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
    title: 'Closure finding',
    reportedByUserId: owner.userId,
  });
  const assigned = await api().post(`/api/v1/findings/${finding.id}/assignments`).set(auth(owner.token)).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(assigned.status, 201);
  for (const state of ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW']) {
    const actorToken = state === 'ASSIGNED' ? owner.token : worker.token;
    const response = await api().patch(`/api/v1/findings/${finding.id}/state`).set(auth(actorToken)).send({ state });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  return { owner, client, building, profile, finding };
}
async function verifiedFinding(owner = { userId, token }) {
  const item = await pendingFinding(owner);
  const review = await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth(owner.token)).send({ notes: 'Review' });
  assert.equal(review.status, 201);
  const approved = await api().post(`/api/v1/findings/${item.finding.id}/verification`).set(auth(owner.token)).send({ decision: 'APPROVED', notes: 'Approved' });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.data.state, 'VERIFIED');
  return item;
}
async function close(id: string, value = token, closureNotes = 'Verified and closed') {
  return api().post(`/api/v1/findings/${id}/close`).set(auth(value)).send({ closureNotes });
}

describe('BE-09H controlled Finding closure', () => {
  it('closes a verified Finding and records closure timestamp, user, and notes', async (t) => {
    if (!ready(t)) return;
    const item = await verifiedFinding();
    const readiness = await api().get(`/api/v1/findings/${item.finding.id}/closure`).set(auth());
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.data.ready, true);
    assert.equal(readiness.body.data.latestVerificationDecision, 'APPROVED');

    const response = await close(item.finding.id);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.state, 'CLOSED');
    assert.ok(response.body.data.closedAt);
    assert.equal(response.body.data.closedByUserId, userId);
    assert.equal(response.body.data.closureNotes, 'Verified and closed');

    const finding = await api().get(`/api/v1/findings/${item.finding.id}`).set(auth());
    assert.equal(finding.body.data.status, 'CLOSED');
    assert.equal(finding.body.data.closedByUserId, userId);
    assert.ok(finding.body.data.closedAt);
  });

  it('rejects closure without a valid approved verification', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    // Pin a legacy/uncontrolled VERIFIED record to prove closure still requires
    // an approved shared verification, regardless of status alone.
    await pool!.query(
      `UPDATE findings SET status='VERIFIED', state_changed_at=NOW() WHERE id=$1`,
      [item.finding.id],
    );
    const response = await close(item.finding.id);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('rejects direct closure from non-closable states', async (t) => {
    if (!ready(t)) return;
    const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
    const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
    const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
    await buildingAssignmentService.createAssignment(userId, { buildingId: building.id });
    const finding = await findingService.createFinding({ clientId: client.id, buildingId: building.id, findingNumber: `FND_${suffix()}`, title: 'Open', reportedByUserId: userId });
    const response = await close(finding.id);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('rejects closure while rework is pending', async (t) => {
    if (!ready(t)) return;
    const item = await pendingFinding();
    await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth()).send({ notes: 'Review' });
    const rework = await api().post(`/api/v1/findings/${item.finding.id}/rework`).set(auth()).send({ reason: 'Correction required' });
    assert.equal(rework.status, 201);
    const response = await close(item.finding.id);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('rejects duplicate closure', async (t) => {
    if (!ready(t)) return;
    const item = await verifiedFinding();
    assert.equal((await close(item.finding.id)).status, 200);
    const duplicate = await close(item.finding.id);
    assert.equal(duplicate.status, 403);
    assert.equal(duplicate.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('keeps CLOSED terminal and blocks the generic state endpoint from closing', async (t) => {
    if (!ready(t)) return;
    const item = await verifiedFinding();
    const genericClose = await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth()).send({ state: 'CLOSED' });
    assert.equal(genericClose.status, 403);
    assert.equal(genericClose.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
    await close(item.finding.id);
    const reverse = await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth()).send({ state: 'IN_PROGRESS' });
    assert.equal(reverse.status, 403);
    assert.equal(reverse.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('rejects an authenticated user without closure authority', async (t) => {
    if (!ready(t)) return;
    const item = await verifiedFinding();
    const plain = await createPlainSession();
    await buildingAssignmentService.createAssignment(
      (await pool!.query<{ id: string }>(`SELECT id FROM users WHERE email LIKE 'plain-%' ORDER BY created_at DESC LIMIT 1`)).rows[0].id,
      { buildingId: item.building.id },
    );
    const response = await close(item.finding.id, plain);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('preserves Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const item = await verifiedFinding(owner);
    const response = await close(item.finding.id);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
