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
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let reviewerToken = '';
let reviewerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE finding_rework_cycles, reviews, finding_assignments, findings, users, roles, clients CASCADE');
  const reviewer = await createAdminUser();
  reviewerToken = reviewer.token;
  reviewerUserId = reviewer.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; });
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = reviewerToken) => ({ Authorization: `Bearer ${token}` });

async function reviewableFinding(
  reviewer = { userId: reviewerUserId, token: reviewerToken },
) {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(reviewer.userId, { buildingId: building.id });
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
    title: 'Rework finding',
    reportedByUserId: reviewer.userId,
  });
  const assignment = await api().post(`/api/v1/findings/${finding.id}/assignments`).set(auth(reviewer.token)).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(assignment.status, 201);
  for (const state of ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW']) {
    const actorToken = state === 'ASSIGNED' ? reviewer.token : worker.token;
    const response = await api().patch(`/api/v1/findings/${finding.id}/state`).set(auth(actorToken)).send({ state });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const review = await api().post(`/api/v1/findings/${finding.id}/reviews`).set(auth(reviewer.token)).send({ notes: 'Review opened' });
  assert.equal(review.status, 201);
  return { reviewer, worker, client, building, finding, profile, review: review.body.data };
}
async function reject(id: string, reason: unknown, token = reviewerToken) {
  return api().post(`/api/v1/findings/${id}/reject`).set(auth(token)).send({ reason });
}
async function rework(id: string, reason: unknown, token = reviewerToken) {
  return api().post(`/api/v1/findings/${id}/rework`).set(auth(token)).send({ reason });
}
async function resubmit(id: string, notes: unknown, token: string) {
  return api().post(`/api/v1/findings/${id}/resubmit`).set(auth(token)).send({ notes });
}

describe('BE-09G Finding reject, rework, and resubmission', () => {
  it('rejects a PENDING_REVIEW Finding with a preserved reason', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    const response = await reject(item.finding.id, 'Evidence is insufficient');
    assert.equal(response.status, 201);
    assert.equal(response.body.data.state, 'REJECTED');
    assert.equal(response.body.data.verification.decision, 'REJECTED');
    assert.equal(response.body.data.verification.notes, 'Evidence is insufficient');
  });

  it('requires a rejection reason', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    const response = await reject(item.finding.id, '');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('requests REWORK_REQUIRED with a required reason and preserves context', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    const missing = await rework(item.finding.id, '');
    assert.equal(missing.status, 400);
    const response = await rework(item.finding.id, 'Correct the damaged seal');
    assert.equal(response.status, 201);
    assert.equal(response.body.data.state, 'REWORK_REQUIRED');
    assert.equal(response.body.data.rework.reason, 'Correct the damaged seal');
    assert.equal(response.body.data.rework.reviewId, item.review.id);

    const notes = await api().patch(`/api/v1/findings/${item.finding.id}/rework`).set(auth(item.worker.token)).send({ notes: 'Seal removed and prepared' });
    assert.equal(notes.status, 200);
    assert.equal(notes.body.data.reworkNotes, 'Seal removed and prepared');
    const context = await api().get(`/api/v1/findings/${item.finding.id}/rework`).set(auth());
    assert.equal(context.status, 200);
    assert.equal(context.body.data.current.id, response.body.data.rework.id);
    assert.equal(context.body.data.cycles.length, 1);
    assert.equal(context.body.data.cycles[0].reason, 'Correct the damaged seal');
  });

  it('allows only the active responsible party to resubmit', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    await rework(item.finding.id, 'Correction required');
    const unauthorized = await resubmit(item.finding.id, 'Manager cannot resubmit', reviewerToken);
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');

    const response = await resubmit(item.finding.id, 'Rework completed', item.worker.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.state, 'PENDING_REVIEW');
    assert.equal(response.body.data.rework.status, 'RESUBMITTED');
    assert.equal(response.body.data.rework.resubmittedByUserId, item.worker.userId);
    assert.equal(response.body.data.rework.reworkNotes, 'Rework completed');
  });

  it('returns RESUBMITTED work to a reviewable state without opening a review', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    await rework(item.finding.id, 'Fix required');
    await resubmit(item.finding.id, 'Fixed', item.worker.token);
    const state = await api().get(`/api/v1/findings/${item.finding.id}/state`).set(auth());
    assert.equal(state.body.data.state, 'PENDING_REVIEW');
    const currentReview = await api().get(`/api/v1/findings/${item.finding.id}/reviews/current`).set(auth());
    assert.equal(currentReview.body.data, null);
  });

  it('preserves multiple reviews and rework cycles', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    await rework(item.finding.id, 'First correction');
    await resubmit(item.finding.id, 'First correction complete', item.worker.token);
    const secondReview = await api().post(`/api/v1/findings/${item.finding.id}/reviews`).set(auth()).send({ notes: 'Second review' });
    assert.equal(secondReview.status, 201);
    await rework(item.finding.id, 'Second correction');
    await resubmit(item.finding.id, 'Second correction complete', item.worker.token);

    const context = await api().get(`/api/v1/findings/${item.finding.id}/rework`).set(auth());
    assert.equal(context.body.data.current, null);
    assert.equal(context.body.data.cycles.length, 2);
    assert.equal(context.body.data.cycles[0].reason, 'First correction');
    assert.equal(context.body.data.cycles[1].reason, 'Second correction');
    const verification = await api().get(`/api/v1/findings/${item.finding.id}/verification`).set(auth());
    assert.equal(verification.body.data.reviews.length, 2);
    assert.equal(verification.body.data.reviews[0].decision, 'REWORK_REQUIRED');
    assert.equal(verification.body.data.reviews[1].decision, 'REWORK_REQUIRED');
  });

  it('rejects actions from invalid and terminal states', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    const invalid = await resubmit(item.finding.id, 'Not in rework', item.worker.token);
    assert.equal(invalid.status, 403);
    assert.equal(invalid.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
    await api().patch(`/api/v1/findings/${item.finding.id}/state`).set(auth()).send({ state: 'CANCELLED' });
    const terminal = await rework(item.finding.id, 'Cannot rework terminal');
    assert.equal(terminal.status, 403);
    assert.equal(terminal.body.error.code, 'FINDING_ACTION_NOT_ALLOWED');
  });

  it('can request rework after an explicit rejection while preserving that review', async (t) => {
    if (!ready(t)) return;
    const item = await reviewableFinding();
    await reject(item.finding.id, 'Rejected first');
    const response = await rework(item.finding.id, 'Correction after rejection');
    assert.equal(response.status, 201);
    assert.equal(response.body.data.state, 'REWORK_REQUIRED');
    assert.equal(response.body.data.rework.reviewId, item.review.id);
  });

  it('preserves Client/Building isolation and RBAC', async (t) => {
    if (!ready(t)) return;
    const owner = await createAdminUser();
    const item = await reviewableFinding(owner);
    const isolated = await rework(item.finding.id, 'Hidden client rework');
    assert.equal(isolated.status, 403);
    assert.equal(isolated.body.error.code, 'BUILDING_ACCESS_DENIED');

    const plain = await createPlainSession();
    const denied = await rework(item.finding.id, 'No permission', plain);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
  });
});
