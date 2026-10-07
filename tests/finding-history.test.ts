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
import { workOrderService } from '../src/modules/work-orders';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerToken = '';
let managerUserId = '';
let scenario: Awaited<ReturnType<typeof buildScenario>> | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE operational_events, finding_rework_cycles, reviews, finding_assignments, findings, users, roles, clients CASCADE');
  const manager = await createAdminUser();
  managerToken = manager.token;
  managerUserId = manager.userId;
  database = db;
});
after(async () => { if (pool) await closePool(pool); pool = null; database = null; scenario = null; });
function ready(t: TestContext): boolean {
  if (!database || !pool) { t.skip('test database unavailable'); return false; }
  return true;
}
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = managerToken) => ({ Authorization: `Bearer ${value}` });

async function buildScenario() {
  const worker = await createAdminUser();
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'Client' });
  const property = await propertyService.createProperty({ clientId: client.id, code: `P_${suffix()}`, name: 'Property' });
  const building = await buildingService.createBuilding({ propertyId: property.id, code: `B_${suffix()}`, name: 'Building' });
  await buildingAssignmentService.createAssignment(managerUserId, { buildingId: building.id });
  await buildingAssignmentService.createAssignment(worker.userId, { buildingId: building.id });
  const organization = await organizationService.createOrganization({ clientId: client.id, code: `O_${suffix()}`, name: 'Organization' });
  const department = await departmentService.createDepartment({ organizationId: organization.id, code: `D_${suffix()}`, name: 'Department' });
  const position = await positionService.createPosition({ organizationId: organization.id, code: `P_${suffix()}`, name: 'Position' });
  const team = await teamService.createTeam({ departmentId: department.id, code: `T_${suffix()}`, name: 'Team' });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({ workforceProfileId: profile.id, buildingId: building.id });
  const finding = await findingService.createFinding({
    clientId: client.id,
    buildingId: building.id,
    findingNumber: `FND_${suffix()}`,
    title: 'Audited finding',
    reportedByUserId: managerUserId,
  });

  const classification = await api().post(`/api/v1/clients/${client.id}/finding-classifications`).set(auth()).send({ code: `CLS_${suffix()}`, name: 'Classification' });
  const severity = await api().post(`/api/v1/clients/${client.id}/finding-severities`).set(auth()).send({ code: `SEV_${suffix()}`, name: 'Severity', rank: 2 });
  assert.equal(classification.status, 201);
  assert.equal(severity.status, 201);
  assert.equal((await api().patch(`/api/v1/findings/${finding.id}`).set(auth()).send({ classificationId: classification.body.data.id, severityId: severity.body.data.id })).status, 200);

  const workOrder = await workOrderService.createWorkOrder({ clientId: client.id, buildingId: building.id, workOrderNumber: `WO_${suffix()}`, title: 'Source', workType: 'GENERAL', createdByUserId: managerUserId });
  assert.equal((await api().patch(`/api/v1/findings/${finding.id}/source`).set(auth()).send({ sourceType: 'WORK_ORDER', sourceId: workOrder.id })).status, 200);

  const first = await api().post(`/api/v1/findings/${finding.id}/assignments`).set(auth()).send({ assigneeType: 'TEAM', teamId: team.id });
  assert.equal(first.status, 201);
  const reassigned = await api().patch(`/api/v1/findings/${finding.id}/assignments/${first.body.data.id}`).set(auth()).send({ assigneeType: 'WORKFORCE', workforceProfileId: profile.id });
  assert.equal(reassigned.status, 200);

  assert.equal((await api().patch(`/api/v1/findings/${finding.id}/state`).set(auth()).send({ state: 'ASSIGNED' })).status, 200);
  assert.equal((await api().patch(`/api/v1/findings/${finding.id}/state`).set(auth(worker.token)).send({ state: 'IN_PROGRESS' })).status, 200);
  assert.equal((await api().patch(`/api/v1/findings/${finding.id}/state`).set(auth(worker.token)).send({ state: 'PENDING_REVIEW' })).status, 200);

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    assert.equal((await api().post(`/api/v1/findings/${finding.id}/reviews`).set(auth()).send({ notes: `Review ${cycle}` })).status, 201);
    if (cycle === 1) {
      assert.equal((await api().post(`/api/v1/findings/${finding.id}/reject`).set(auth()).send({ reason: 'Rejected; password=TOP_SECRET' })).status, 201);
    }
    assert.equal((await api().post(`/api/v1/findings/${finding.id}/rework`).set(auth()).send({ reason: `Correction ${cycle}; Authorization: Bearer TOP_SECRET` })).status, 201);
    assert.equal((await api().post(`/api/v1/findings/${finding.id}/resubmit`).set(auth(worker.token)).send({ notes: `Cycle ${cycle} complete; token=TOP_SECRET` })).status, 200);
  }

  assert.equal((await api().post(`/api/v1/findings/${finding.id}/reviews`).set(auth()).send({ notes: 'Final review' })).status, 201);
  assert.equal((await api().post(`/api/v1/findings/${finding.id}/verification`).set(auth()).send({ decision: 'APPROVED', notes: 'Verified' })).status, 201);
  assert.equal((await api().post(`/api/v1/findings/${finding.id}/close`).set(auth()).send({ closureNotes: 'Closed without exposing TOP_SECRET' })).status, 200);
  return { worker, client, property, building, finding };
}
async function ensureScenario() {
  scenario ??= await buildScenario();
  return scenario;
}

describe('BE-09K Finding workflow history', () => {
  it('records complete append-oriented workflow coverage in deterministic order', async (t) => {
    if (!ready(t)) return;
    const item = await ensureScenario();
    const response = await api().get(`/api/v1/findings/${item.finding.id}/history`).set(auth());
    assert.equal(response.status, 200);
    const events = response.body.data;
    const types = events.map((event: { eventType: string }) => event.eventType);
    for (const expected of [
      'FINDING_CREATED',
      'FINDING_CLASSIFICATION_CHANGED',
      'FINDING_SEVERITY_CHANGED',
      'FINDING_SOURCE_CHANGED',
      'FINDING_ASSIGNED',
      'FINDING_REASSIGNED',
      'FINDING_STATE_CHANGED',
      'FINDING_REVIEW_OPENED',
      'FINDING_VERIFICATION_SUBMITTED',
      'FINDING_REJECTED',
      'FINDING_REWORK_REQUESTED',
      'FINDING_RESUBMITTED',
      'FINDING_VERIFIED',
      'FINDING_CLOSED',
    ]) assert.ok(types.includes(expected), `missing ${expected}`);
    assert.equal(types.filter((type: string) => type === 'FINDING_REWORK_REQUESTED').length, 2);
    assert.equal(types.filter((type: string) => type === 'FINDING_RESUBMITTED').length, 2);

    const tuples = events.map((event: { occurredAt: string; id: string }) => `${event.occurredAt}|${event.id}`);
    assert.deepEqual(tuples, [...tuples].sort());
    assert.equal(JSON.stringify(events).includes('TOP_SECRET'), false);
    assert.ok(events.every((event: { findingId: string; clientId: string; buildingId: string }) =>
      event.findingId === item.finding.id && event.clientId === item.client.id && event.buildingId === item.building.id));
  });

  it('supports safe event and date filtering', async (t) => {
    if (!ready(t)) return;
    const item = await ensureScenario();
    const filtered = await api().get(`/api/v1/findings/${item.finding.id}/history?eventType=FINDING_REWORK_REQUESTED`).set(auth());
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.length, 2);
    assert.ok(filtered.body.data.every((event: { eventType: string }) => event.eventType === 'FINDING_REWORK_REQUESTED'));
    const from = encodeURIComponent(filtered.body.data[0].occurredAt);
    const dated = await api().get(`/api/v1/findings/${item.finding.id}/history?from=${from}`).set(auth());
    assert.equal(dated.status, 200);
    assert.ok(dated.body.data.length > 0);
  });

  it('enforces Building isolation, RBAC, and read-only event creation', async (t) => {
    if (!ready(t)) return;
    const item = await ensureScenario();
    const outsider = await createAdminUser();
    const crossClient = await api().get(`/api/v1/findings/${item.finding.id}/history`).set(auth(outsider.token));
    assert.equal(crossClient.status, 403);
    assert.equal(crossClient.body.error.code, 'BUILDING_ACCESS_DENIED');

    const siblingProperty = await propertyService.createProperty({ clientId: item.client.id, code: `P_${suffix()}`, name: 'Sibling' });
    const sibling = await buildingService.createBuilding({ propertyId: siblingProperty.id, code: `B_${suffix()}`, name: 'Sibling' });
    await buildingAssignmentService.createAssignment(outsider.userId, { buildingId: sibling.id });
    assert.equal((await api().get(`/api/v1/findings/${item.finding.id}/history`).set(auth(outsider.token))).status, 403);

    const plain = await createPlainSession();
    const denied = await api().get(`/api/v1/findings/${item.finding.id}/history`).set(auth(plain));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    assert.equal((await api().post(`/api/v1/findings/${item.finding.id}/history`).set(auth()).send({ eventType: 'FABRICATED' })).status, 404);
  });
});
