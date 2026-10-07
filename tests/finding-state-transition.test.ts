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
import { teamService } from '../src/modules/teams';
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

async function fixture(assignTo: string | null = userId, reporter = userId) {
  const actor = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  if (assignTo) await buildingAssignmentService.createAssignment(assignTo, { buildingId: building.id });
  await buildingAssignmentService.createAssignment(actor.userId, { buildingId: building.id });
  const organization = await organizationService.createOrganization({ clientId: client.id, code: `O_${suffix()}`, name: 'Organization' });
  const department = await departmentService.createDepartment({ organizationId: organization.id, code: `D_${suffix()}`, name: 'Department' });
  const team = await teamService.createTeam({ departmentId: department.id, code: `T_${suffix()}`, name: 'Team' });
  const position = await positionService.createPosition({ organizationId: organization.id, code: `POS_${suffix()}`, name: 'Position' });
  await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    userId: actor.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Assigned actor',
  });
  const finding = await findingService.createFinding({
    clientId: client.id,
    buildingId: building.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Workflow finding',
    reportedByUserId: reporter,
  });
  return { actor, client, building, team, finding };
}
async function assignTeam(findingId: string, teamId: string, value = token) {
  return api().post(`/api/v1/findings/${findingId}/assignments`).set(auth(value)).send({ assigneeType: 'TEAM', teamId });
}
async function transition(findingId: string, state: string, value = token) {
  return api().patch(`/api/v1/findings/${findingId}/state`).set(auth(value)).send({ state });
}
async function reachPendingReview(item: Awaited<ReturnType<typeof fixture>>, value = token) {
  assert.equal((await assignTeam(item.finding.id, item.team.id, value)).status, 201);
  for (const state of ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW']) {
    const actorToken = state === 'ASSIGNED' ? value : item.actor.token;
    const response = await transition(item.finding.id, state, actorToken);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.state, state);
  }
}

describe('BE-09E Finding operational state transitions', () => {
  it('transitions OPEN to ASSIGNED, ASSIGNED to IN_PROGRESS, and IN_PROGRESS to PENDING_REVIEW', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPendingReview(item);
    const current = await api().get(`/api/v1/findings/${item.finding.id}/state`).set(auth());
    assert.equal(current.status, 200);
    assert.equal(current.body.data.state, 'PENDING_REVIEW');
    assert.ok(current.body.data.stateChangedAt);
  });

  it('requires an active assignment before entering ASSIGNED', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    const response = await transition(item.finding.id, 'ASSIGNED');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('delegates PENDING_REVIEW to REWORK_REQUIRED to the review action', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPendingReview(item);
    assert.equal((await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth()).send({})).status, 201);
    const response = await api().post(`/api/v1/findings/${item.finding.id}/rework`).set(auth()).send({ reason: 'Correction required' });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.state, 'REWORK_REQUIRED');
    const bypass = await transition(item.finding.id, 'IN_PROGRESS');
    assert.equal(bypass.status, 403);
    assert.equal(bypass.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('supports REWORK_REQUIRED through controlled resubmission to PENDING_REVIEW', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPendingReview(item);
    await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth()).send({});
    await api().post(`/api/v1/findings/${item.finding.id}/rework`).set(auth()).send({ reason: 'Correction required' });
    const resubmitted = await api().post(`/api/v1/findings/${item.finding.id}/resubmit`).set(auth(item.actor.token)).send({ notes: 'Corrected' });
    assert.equal(resubmitted.status, 200);
    assert.equal(resubmitted.body.data.state, 'PENDING_REVIEW');
  });

  it('supports PENDING_REVIEW to VERIFIED through verification and delegates closure', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await reachPendingReview(item);
    await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth()).send({});
    const verified = await api().post(`/api/v1/findings/${item.finding.id}/verification`).set(auth()).send({ decision: 'APPROVED' });
    assert.equal(verified.status, 201);
    assert.equal(verified.body.data.state, 'VERIFIED');
    const directClose = await transition(item.finding.id, 'CLOSED');
    assert.equal(directClose.status, 403);
    assert.equal(directClose.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('allows cancellation from a non-terminal operational state', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await assignTeam(item.finding.id, item.team.id);
    await transition(item.finding.id, 'ASSIGNED');
    await transition(item.finding.id, 'IN_PROGRESS', item.actor.token);
    const cancelled = await transition(item.finding.id, 'CANCELLED');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.state, 'CANCELLED');
  });

  it('rejects invalid reverse transitions and protects terminal states', async (t) => {
    if (!ready(t)) return;
    const item = await fixture();
    await assignTeam(item.finding.id, item.team.id);
    await transition(item.finding.id, 'ASSIGNED');
    const reverse = await transition(item.finding.id, 'OPEN');
    assert.equal(reverse.status, 403);
    assert.equal(reverse.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
    await transition(item.finding.id, 'CANCELLED');
    const terminal = await transition(item.finding.id, 'ASSIGNED');
    assert.equal(terminal.status, 403);
    assert.equal(terminal.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('returns not found for an unknown Finding', async (t) => {
    if (!ready(t)) return;
    const response = await transition(randomUUID(), 'ASSIGNED');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FINDING_NOT_FOUND');
  });

  it('preserves Client/Building isolation and RBAC', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const item = await fixture(owner.userId, owner.userId);
    await assignTeam(item.finding.id, item.team.id, owner.token);
    const isolated = await transition(item.finding.id, 'ASSIGNED');
    assert.equal(isolated.status, 403);
    assert.equal(isolated.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const denied = await transition(item.finding.id, 'ASSIGNED', plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
