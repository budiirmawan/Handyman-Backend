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
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-API-01 PART 02 — legacy operational data-scope remediation.
 *
 * Proves that legacy operational list/read endpoints return ONLY records
 * inside the authenticated user's accessible Building/Client scope:
 *   - allowed Building data is returned,
 *   - inaccessible Building data (same Client) is excluded,
 *   - cross-Client data is excluded,
 *   - existing authorized access still works.
 *
 * Scope model under test (BE-02G): a user with an ACTIVE assignment to
 * buildingA1 may see data of clientA/buildingA1, but NOT clientA/buildingA2
 * (inaccessible sibling Building) and NOT clientB (cross-Client).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let adminUserId = '';

let clientA = '';
let clientB = '';
let buildingA1 = '';
let buildingA2 = '';
let workforceProfileId = '';

let ceA = '';
let ceB = '';
let fiA = '';
let fiB = '';
let gtA1 = '';
let gtA2 = '';
let gtB = '';
let esA = '';
let erA = '';
let sdA1 = '';
let sdA2 = '';
let sdB = '';
let rvA = '';
let uomA = '';
let uomB = '';
let evA1 = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(table: string, values: Record<string, unknown>): Promise<string> {
  const rowId = id();
  const entries = Object.entries(values);
  const columns = entries.map(([column]) => column).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 2}`).join(', ');
  await q(
    `INSERT INTO ${table} (id, ${columns}) VALUES ($1, ${placeholders})`,
    [rowId, ...entries.map(([, value]) => value)],
  );
  return rowId;
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, organizations, departments, positions,
      workforce_profiles, source_forms, form_templates, form_template_versions,
      form_instances, checklist_templates, checklist_executions,
      schedule_definitions, schedule_recurrence, generated_tasks,
      task_assignments, evidence_requirements, evidence_submissions, reviews,
      units_of_measure, operational_events
     CASCADE`,
  );

  const admin = await createAdminUser();
  token = admin.token;
  adminUserId = admin.userId;

  // Client A with two buildings; Client B with one building.
  const a = await clientService.createClient({
    code: `CLI_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Property A',
  });
  const b1 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_A1_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building A1',
  });
  const b2 = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_A2_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building A2',
  });
  const b = await clientService.createClient({
    code: `CLI_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Property B',
  });
  const bB = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_B1_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Building B1',
  });

  clientA = a.id;
  clientB = b.id;
  buildingA1 = b1.id;
  buildingA2 = b2.id;

  // The administrator can access ONLY buildingA1 (of clientA).
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA1,
  });

  // Workforce profile under clientA (for assignment-list scoping).
  const org = await organizationService.createOrganization({
    clientId: clientA,
    code: `ORG_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Org A',
  });
  const dept = await departmentService.createDepartment({
    organizationId: org.id,
    code: `DEPT_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Dept A',
  });
  const pos = await positionService.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    code: `POS_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Position A',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: pos.id,
    employeeCode: `EMP_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    fullName: 'Worker A',
  });
  workforceProfileId = profile.id;

  // --- checklist templates + executions (client-scoped tables) ---
  const ctA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `CT_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist A',
    status: 'ACTIVE',
  });
  const ctB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `CT_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Checklist B',
    status: 'ACTIVE',
  });

  ceA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: ctA,
  });
  ceB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: ctB,
  });

  // --- form templates + versions + instances (client-scoped tables) ---
  const sfA = await insertRow('source_forms', {
    client_id: clientA,
    code: `SF_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Source A',
    source_type: 'INTERNAL',
  });
  const ftA = await insertRow('form_templates', {
    source_form_id: sfA,
    client_id: clientA,
    code: `FT_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Form A',
  });
  const fvA = await insertRow('form_template_versions', {
    form_template_id: ftA,
    version_number: 1,
  });
  const sfB = await insertRow('source_forms', {
    client_id: clientB,
    code: `SF_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Source B',
    source_type: 'INTERNAL',
  });
  const ftB = await insertRow('form_templates', {
    source_form_id: sfB,
    client_id: clientB,
    code: `FT_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Form B',
  });
  const fvB = await insertRow('form_template_versions', {
    form_template_id: ftB,
    version_number: 1,
  });

  fiA = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: fvA,
  });
  fiB = await insertRow('form_instances', {
    client_id: clientB,
    form_template_version_id: fvB,
  });

  // --- schedules + recurrence + generated tasks (building-or-client tables) ---
  sdA1 = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SCH_A1_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Schedule A1',
    target_type: 'FORM_TEMPLATE',
    target_id: ftA,
    building_id: buildingA1,
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });
  sdA2 = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SCH_A2_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Schedule A2',
    target_type: 'FORM_TEMPLATE',
    target_id: ftA,
    building_id: buildingA2,
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });
  sdB = await insertRow('schedule_definitions', {
    client_id: clientB,
    code: `SCH_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Schedule B',
    target_type: 'FORM_TEMPLATE',
    target_id: ftB,
    building_id: bB.id,
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });

  await insertRow('schedule_recurrence', {
    schedule_definition_id: sdA1,
    frequency: 'DAILY',
    interval: 1,
    start_date: new Date().toISOString().slice(0, 10),
  });

  gtA1 = await insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: sdA1,
    occurrence_at: new Date().toISOString(),
    target_type: 'FORM_TEMPLATE',
    target_id: ftA,
    building_id: buildingA1,
  });
  gtA2 = await insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: sdA2,
    occurrence_at: new Date().toISOString(),
    target_type: 'FORM_TEMPLATE',
    target_id: ftA,
    building_id: buildingA2,
  });
  gtB = await insertRow('generated_tasks', {
    client_id: clientB,
    schedule_definition_id: sdB,
    occurrence_at: new Date().toISOString(),
    target_type: 'FORM_TEMPLATE',
    target_id: ftB,
    building_id: bB.id,
  });

  // task assignments: accessible task (A1) and inaccessible task (A2) for the same workforce.
  await insertRow('task_assignments', {
    task_id: gtA1,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: workforceProfileId,
    assigned_by_user_id: adminUserId,
    assigned_at: new Date().toISOString(),
  });
  await insertRow('task_assignments', {
    task_id: gtA2,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: workforceProfileId,
    assigned_by_user_id: adminUserId,
    assigned_at: new Date().toISOString(),
  });

  // --- evidence requirements + submissions (client-scoped tables) ---
  erA = await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: ctA,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
  });
  await insertRow('evidence_requirements', {
    client_id: clientB,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: ctB,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
  });

  esA = await insertRow('evidence_submissions', {
    client_id: clientA,
    execution_type: 'CHECKLIST_EXECUTION',
    execution_id: ceA,
    evidence_type: 'PHOTO',
    file_reference: 'ref-a',
    original_file_name: 'a.jpg',
    mime_type: 'image/jpeg',
    file_size: 100,
  });
  await insertRow('evidence_submissions', {
    client_id: clientB,
    execution_type: 'CHECKLIST_EXECUTION',
    execution_id: ceB,
    evidence_type: 'PHOTO',
    file_reference: 'ref-b',
    original_file_name: 'b.jpg',
    mime_type: 'image/jpeg',
    file_size: 100,
  });

  // --- reviews (client-scoped table) ---
  rvA = await insertRow('reviews', {
    client_id: clientA,
    target_type: 'FORM_INSTANCE',
    target_id: fiA,
    reviewer_user_id: adminUserId,
  });
  await insertRow('reviews', {
    client_id: clientB,
    target_type: 'FORM_INSTANCE',
    target_id: fiB,
    reviewer_user_id: adminUserId,
  });

  // --- units of measure (client-scoped table) ---
  uomA = await insertRow('units_of_measure', {
    client_id: clientA,
    code: `UOM_A_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Unit A',
    symbol: 'u',
    category: 'COUNT',
  });
  uomB = await insertRow('units_of_measure', {
    client_id: clientB,
    code: `UOM_B_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Unit B',
    symbol: 'u',
    category: 'COUNT',
  });

  // --- operational events (building-or-client table) ---
  evA1 = await insertRow('operational_events', {
    client_id: clientA,
    event_type: 'TEST_EVENT',
    entity_type: 'ASSET',
    entity_id: randomUUID(),
    actor_user_id: adminUserId,
    building_id: buildingA1,
    summary: 'event a1',
  });
  await insertRow('operational_events', {
    client_id: clientA,
    event_type: 'TEST_EVENT',
    entity_type: 'ASSET',
    entity_id: randomUUID(),
    actor_user_id: adminUserId,
    building_id: buildingA2,
    summary: 'event a2',
  });

  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function ids(body: { data: { id: string }[] }): string[] {
  return body.data.map((row) => row.id);
}

describe('CR-BE-API-01 PART 02 — operational data scope', () => {
  it('returns allowed Building data and excludes inaccessible Building and cross-Client tasks', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api().get('/api/v1/tasks').set(auth());
    assert.equal(response.status, 200);
    const got = ids(response.body);
    assert.ok(got.includes(gtA1), 'accessible Building task must be returned');
    assert.ok(!got.includes(gtA2), 'inaccessible Building task (same Client) must be excluded');
    assert.ok(!got.includes(gtB), 'cross-Client task must be excluded');
  });

  it('scopes checklist executions and form instances by accessible Client', async (t) => {
    if (!requireDatabase(t)) return;

    const executions = await api().get('/api/v1/checklist-executions').set(auth());
    assert.equal(executions.status, 200);
    assert.deepEqual(ids(executions.body), [ceA]);
    assert.equal(
      (await api().get(`/api/v1/checklist-executions/${ceB}`).set(auth())).status,
      403,
      'inaccessible checklist execution read must be denied',
    );

    const instances = await api().get('/api/v1/form-instances').set(auth());
    assert.equal(instances.status, 200);
    assert.deepEqual(ids(instances.body), [fiA]);
    assert.equal(
      (await api().get(`/api/v1/form-instances/${fiB}`).set(auth())).status,
      403,
      'inaccessible form instance read must be denied',
    );
  });

  it('scopes evidence and evidence requirements by accessible Client', async (t) => {
    if (!requireDatabase(t)) return;

    const evidence = await api().get('/api/v1/evidence').set(auth());
    assert.equal(evidence.status, 200);
    assert.deepEqual(ids(evidence.body), [esA]);

    const requirements = await api().get('/api/v1/evidence-requirements').set(auth());
    assert.equal(requirements.status, 200);
    assert.deepEqual(ids(requirements.body), [erA]);
  });

  it('scopes schedule lists and recurrence reads by accessible Building/Client', async (t) => {
    if (!requireDatabase(t)) return;

    const schedules = await api().get('/api/v1/schedules').set(auth());
    assert.equal(schedules.status, 200);
    const got = ids(schedules.body);
    assert.ok(got.includes(sdA1), 'accessible Building schedule must be returned');
    assert.ok(!got.includes(sdA2), 'inaccessible Building schedule (same Client) must be excluded');
    assert.ok(!got.includes(sdB), 'cross-Client schedule must be excluded');

    assert.equal(
      (await api().get(`/api/v1/schedules/${sdA1}/recurrence`).set(auth())).status,
      200,
      'accessible schedule recurrence must be readable',
    );
    assert.equal(
      (await api().get(`/api/v1/schedules/${sdA2}/recurrence`).set(auth())).status,
      403,
      'inaccessible schedule recurrence must be denied',
    );
    assert.equal(
      (await api().get(`/api/v1/schedules/${sdB}/recurrence`).set(auth())).status,
      403,
      'cross-Client schedule recurrence must be denied',
    );
  });

  it('scopes assignment lists by parent task access and workforce scope', async (t) => {
    if (!requireDatabase(t)) return;

    assert.equal(
      (await api().get(`/api/v1/tasks/${gtA1}/assignments`).set(auth())).status,
      200,
      'assignments of an accessible task must be readable',
    );
    assert.equal(
      (await api().get(`/api/v1/tasks/${gtA2}/assignments`).set(auth())).status,
      403,
      'assignments of an inaccessible task must be denied',
    );

    const workforce = await api()
      .get(`/api/v1/workforce/${workforceProfileId}/tasks`)
      .set(auth());
    assert.equal(workforce.status, 200);
    const got = ids(workforce.body);
    assert.ok(got.includes(gtA1), 'assigned accessible task must be returned');
    assert.ok(!got.includes(gtA2), 'assigned task in an inaccessible Building must be excluded');
  });

  it('scopes reviews by accessible Client', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api().get('/api/v1/reviews').set(auth());
    assert.equal(response.status, 200);
    assert.deepEqual(ids(response.body), [rvA]);
  });

  it('scopes units of measure by accessible Client', async (t) => {
    if (!requireDatabase(t)) return;

    const own = await api().get(`/api/v1/clients/${clientA}/uoms`).set(auth());
    assert.equal(own.status, 200);
    assert.deepEqual(ids(own.body), [uomA]);

    assert.equal(
      (await api().get(`/api/v1/clients/${clientB}/uoms`).set(auth())).status,
      403,
      'listing UOMs of an inaccessible Client must be denied',
    );
    assert.equal(
      (await api().get(`/api/v1/uoms/${uomA}`).set(auth())).status,
      200,
      'accessible UOM read must still work',
    );
    assert.equal(
      (await api().get(`/api/v1/uoms/${uomB}`).set(auth())).status,
      403,
      'cross-Client UOM read must be denied',
    );
  });

  it('scopes operational events by accessible Building/Client', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api().get('/api/v1/operational-events').set(auth());
    assert.equal(response.status, 200);
    const got = ids(response.body);
    assert.ok(got.includes(evA1), 'accessible Building event must be returned');
    assert.ok(
      !got.some((rowId) => rowId !== evA1),
      'no inaccessible Building or cross-Client event may be returned',
    );
  });

  it('keeps existing authorized access working', async (t) => {
    if (!requireDatabase(t)) return;

    const me = await api().get('/api/v1/auth/me').set(auth());
    assert.equal(me.status, 200);

    const execution = await api().get(`/api/v1/checklist-executions/${ceA}`).set(auth());
    assert.equal(execution.status, 200);
    assert.equal(execution.body.data.id, ceA);

    const task = await api().get(`/api/v1/tasks/${gtA1}`).set(auth());
    assert.equal(task.status, 200);
    assert.equal(task.body.data.id, gtA1);
  });
});
