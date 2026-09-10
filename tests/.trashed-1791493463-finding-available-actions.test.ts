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

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(assign = true) {
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
    fullName: 'Responsible worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: profile.id, buildingId: building.id });
  const finding = await findingService.createFinding({
    clientId: client.id,
    buildingId: building.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Action resolver finding',
    reportedByUserId: managerUserId,
  });
  if (assign) {
    const response = await api().post(`/api/v1/findings/${finding.id}/assignments`).set(auth()).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
    assert.equal(response.status, 201);
  }
  return { worker, client, property, building, profile, finding };
}
async function transition(item: Fixture, state: string, token = managerToken) {
  const response = await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth(token)).send({ state });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
async function reachAssigned(item: Fixture) { await transition(item, 'ASSIGNED'); }
async function reachInProgress(item: Fixture) {
  await reachAssigned(item);
  await transition(item, 'IN_PROGRESS', item.worker.token);
}
async function reachPending(item: Fixture) {
  await reachInProgress(item);
  await transition(item, 'PENDING_REVIEW', item.worker.token);
}
async function openReview(item: Fixture) {
  const response = await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth()).send({ notes: 'Review' });
  assert.equal(response.status, 201);
}
async function actions(item: Fixture, token = managerToken) {
  return api().get(`/api/v1/findings/${item.finding.id}/available-actions`).set(auth(token));
}

describe('BE-09I Finding available action resolver', () => {
  it('returns deterministic valid initial actions for OPEN', async (t) => {
    if (!ready(t)) return;
    const item = await fixture(false);
    const first = await actions(item);
    const second = await actions(item);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.availableActions, ['ASSIGN', 'CANCEL']);
    assert.deepEqual(second.body.data, first.body.data);
  });

  it('returns START only to the assignee in ASSIGNED', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachAssigned(item);
    const worker = await actions(item, item.worker.token);
    assert.deepEqual(worker.body.data.availableActions, ['START', 'CANCEL']);
    const nonAssignee = await actions(item);
    assert.deepEqual(nonAssignee.body.data.availableActions, ['CANCEL']);
    assert.equal(nonAssignee.body.data.availableActions.includes('START'), false);
  });

  it('returns SUBMIT_FOR_REVIEW to the assignee in IN_PROGRESS', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachInProgress(item);
    const response = await actions(item, item.worker.token);
    assert.deepEqual(response.body.data.availableActions, ['SUBMIT_FOR_REVIEW', 'CANCEL']);
    assert.equal(response.body.data.availableActions.includes('START'), false);
  });

  it('returns only valid review actions to the current reviewer in PENDING_REVIEW', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPending(item);
    await openReview(item);
    const reviewer = await actions(item);
    assert.deepEqual(reviewer.body.data.availableActions, [
      'APPROVE', 'REJECT', 'REQUEST_REWORK', 'CANCEL',
    ]);
    const worker = await actions(item, item.worker.token);
    assert.deepEqual(worker.body.data.availableActions, ['CANCEL']);
  });

  it('returns RESUBMIT in REWORK_REQUIRED and review submission in RESUBMITTED', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPending(item);
    await openReview(item);
    const rework = await api().post(`/api/v1/findings/${item.finding.id}/rework`).set(auth()).send({ reason: 'Correction required' });
    assert.equal(rework.status, 201);
    const required = await actions(item, item.worker.token);
    assert.deepEqual(required.body.data.availableActions, ['RESUBMIT', 'CANCEL']);

    // RESUBMITTED is normally transient inside the resubmit orchestration;
    // pin it directly here to validate this representative resolver state.
    await pool!.query(
      `UPDATE findings SET status='RESUBMITTED', state_changed_at=NOW()
       WHERE id=$1`,
      [item.finding.id],
    );
    const resubmitted = await actions(item, item.worker.token);
    assert.deepEqual(resubmitted.body.data.availableActions, ['SUBMIT_FOR_REVIEW', 'CANCEL']);
    assert.equal(resubmitted.body.data.availableActions.includes('RESUBMIT'), false);
  });

  it('returns CLOSE only when VERIFIED closure readiness is satisfied', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPending(item);
    await openReview(item);
    const approved = await api().post(`/api/v1/findings/${item.finding.id}/verification`).set(auth()).send({ decision: 'APPROVED', notes: 'Approved' });
    assert.equal(approved.status, 201);
    const response = await actions(item);
    assert.deepEqual(response.body.data.availableActions, ['CLOSE']);
  });

  it('returns no normal actions for CLOSED', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPending(item);
    await openReview(item);
    await api().post(`/api/v1/findings/${item.finding.id}/verification`).set(auth()).send({ decision: 'APPROVED' });
    assert.equal((await api().post(`/api/v1/findings/${item.finding.id}/close`).set(auth()).send({})).status, 200);
    const response = await actions(item);
    assert.deepEqual(response.body.data.availableActions, []);
  });

  it('does not return privileged actions to a read-only User', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    const reader = await createAdminUser();
    await buildingAssignmentService.createAssignment(reader.userId, { buildingId: item.building.id });
    await pool!.query(
      `UPDATE role_permission_assignments rpa SET status='REVOKED'
       FROM user_role_assignments ura, permissions p
       WHERE ura.role_id=rpa.role_id AND ura.user_id=$1
         AND p.id=rpa.permission_id
         AND p.code IN (
           'finding.manage', 'finding.assign', 'finding.execute',
           'finding.review', 'finding.close'
         )`,
      [reader.userId],
    );
    const response = await actions(item, reader.token);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.availableActions, []);
  });

  it('rejects cross-Client and cross-Building action resolution', async (t) => {
    if (!ready(t)) return;
    const target = await fixture();
    const outsider = await createAdminUser();

    const foreignClient = await clientService.createClient({ code: `C_${suffix()}`, name: 'Foreign' });
    const foreignProperty = await propertyService.createProperty({ clientId: foreignClient.id, code: `P_${suffix()}`, name: 'Foreign' });
    const foreignBuilding = await buildingService.createBuilding({ propertyId: foreignProperty.id, code: `B_${suffix()}`, name: 'Foreign' });
    await buildingAssignmentService.createAssignment(outsider.userId, { buildingId: foreignBuilding.id });
    const crossClient = await actions(target, outsider.token);
    assert.equal(crossClient.status, 403);
    assert.equal(crossClient.body.error.code, 'BUILDING_ACCESS_DENIED');

    const siblingProperty = await propertyService.createProperty({ clientId: target.client.id, code: `P_${suffix()}`, name: 'Sibling' });
    const sibling = await buildingService.createBuilding({ propertyId: siblingProperty.id, code: `B_${suffix()}`, name: 'Sibling' });
    await buildingAssignmentService.createAssignment(outsider.userId, { buildingId: sibling.id });
    const crossBuilding = await actions(target, outsider.token);
    assert.equal(crossBuilding.status, 403);
    assert.equal(crossBuilding.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
