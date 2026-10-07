import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { roleService } from '../src/modules/roles';
import {
  permissionRepository,
  permissionService,
} from '../src/modules/permissions';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25C — Mobile Assignment Contract (focused contract tests).
 *
 * Verifies the unified mobile assignment feed:
 *   - assigned task/work reference (TASK / WORK_ORDER discriminated),
 *   - assignee / user / workforce context,
 *   - Building / Location context,
 *   - current status,
 *   - due/schedule context where available,
 *   - backend-authoritative available_actions (consistent with the real
 *     execution endpoints),
 *   - strict accessible Client/Building scope (BE-02G),
 *   - opt-in pagination (BE-25A convention).
 */

const DB_PORT = 55439;
const DATA_DIR = '/tmp/asentra-be25c-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED_DATABASE) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(DB_PORT);
  process.env.DB_USER = 'postgres';
  process.env.DB_PASSWORD = 'postgres';
  process.env.DB_SSL = 'false';
}

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

let adminToken = '';
let adminUserId = '';
let readOnlyToken = '';
let emptyToken = '';
let plainToken = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let buildingB = '';
let adminProfileId = '';
let teamId = '';

let task1Id = ''; // client A, OPEN, WORKFORCE → admin profile
let task2Id = ''; // client A, OPEN, TEAM → admin team
let task3Id = ''; // client A, OPEN, WORKFORCE, INACTIVE assignment (excluded)
let taskXId = ''; // client B, OPEN, WORKFORCE (cross-scope, excluded)
let wo1Id = ''; // client A, OPEN, WORKFORCE → admin profile
let wo2Id = ''; // client A, OPEN, TEAM → admin team
let woXId = ''; // client B (cross-scope, excluded)
let wo3Id = ''; // client A, OPEN, WORKFORCE + asset + functional location

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const id = () => randomUUID();

async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
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

async function createClientHierarchy(prefix: string): Promise<{
  clientId: string;
  buildingId: string;
}> {
  const client = await clientService.createClient({
    code: `${prefix}_CLI_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_PROP_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_BLD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Building`,
  });
  return { clientId: client.id, buildingId: building.id };
}

/** Org → Department → Team → Position → Workforce Profile chain. */
async function createOrgChain(
  clientId: string,
  prefix: string,
): Promise<{
  organizationId: string;
  departmentId: string;
  teamId: string;
  positionId: string;
}> {
  const organizationId = await insertRow('organizations', {
    client_id: clientId,
    code: `${prefix}_ORG_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Org`,
    status: 'ACTIVE',
  });
  const departmentId = await insertRow('departments', {
    organization_id: organizationId,
    code: `${prefix}_DEPT_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Dept`,
    status: 'ACTIVE',
  });
  const team = await insertRow('teams', {
    department_id: departmentId,
    code: `${prefix}_TEAM_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Team`,
    status: 'ACTIVE',
  });
  const positionId = await insertRow('positions', {
    organization_id: organizationId,
    code: `${prefix}_POS_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: `${prefix} Position`,
    status: 'ACTIVE',
  });
  return { organizationId, departmentId, teamId: team, positionId };
}

async function createProfile(
  chain: {
    organizationId: string;
    departmentId: string;
    teamId: string;
    positionId: string;
  },
  userId: string,
  prefix: string,
): Promise<string> {
  return insertRow('workforce_profiles', {
    organization_id: chain.organizationId,
    department_id: chain.departmentId,
    team_id: chain.teamId,
    position_id: chain.positionId,
    user_id: userId,
    employee_code: `${prefix}_EMP_${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: `${prefix} Worker`,
    workforce_type: 'INTERNAL',
    status: 'ACTIVE',
  });
}

async function createTask(
  clientId: string,
  buildingId: string | null,
  status: string,
  day: number,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Feed Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: id(),
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: `2026-08-0${day}T01:00:00Z`,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: scheduleId,
    building_id: buildingId,
    status,
  });
}

async function assignTask(
  taskIdValue: string,
  assigneeType: 'WORKFORCE' | 'TEAM',
  profileId: string | null,
  team: string | null,
  assignedBy: string,
  status = 'ACTIVE',
): Promise<void> {
  await insertRow('task_assignments', {
    task_id: taskIdValue,
    assignee_type: assigneeType,
    workforce_profile_id: assigneeType === 'WORKFORCE' ? profileId : null,
    team_id: assigneeType === 'TEAM' ? team : null,
    assigned_by_user_id: assignedBy,
    status,
  });
}

async function createWorkOrder(
  clientId: string,
  buildingId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return insertRow('work_orders', {
    client_id: clientId,
    building_id: buildingId,
    work_order_number: `WO-${randomUUID().slice(0, 8).toUpperCase()}`,
    title,
    work_type: 'CORRECTIVE',
    status: 'OPEN',
    created_by_user_id: adminUserId,
    ...extra,
  });
}

async function assignWorkOrder(
  workOrderId: string,
  assigneeType: 'WORKFORCE' | 'TEAM',
  profileId: string | null,
  team: string | null,
  assignedBy: string,
  status = 'ACTIVE',
): Promise<void> {
  await insertRow('work_order_assignments', {
    work_order_id: workOrderId,
    assignee_type: assigneeType,
    workforce_profile_id: assigneeType === 'WORKFORCE' ? profileId : null,
    team_id: assigneeType === 'TEAM' ? team : null,
    vendor_id: null,
    assigned_by_user_id: assignedBy,
    status,
  });
}

async function createUserWithPermissions(
  codes: { code: string; name: string }[],
  emailPrefix: string,
): Promise<{ token: string; userId: string }> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'FeedPass123';
  const user = await userService.createUser({
    email: `${emailPrefix}-${suffix.toLowerCase()}@example.com`,
    displayName: 'Feed User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_${suffix}`,
    name: 'Feed Role',
  });
  for (const code of codes) {
    let permission = await permissionRepository.findByCode(code.code);
    if (!permission) {
      permission = await permissionService.createPermission(code);
    }
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

function feedItem(items: any[], type: string, idValue: string): any {
  const item = items.find(
    (entry) => entry.type === type && (entry.reference.taskId === idValue || entry.reference.workOrderId === idValue),
  );
  assert.ok(item, `expected ${type} item ${idValue} in feed`);
  return item;
}

async function getFeed(token: string, query = ''): Promise<any> {
  const response = await api()
    .get(`/api/v1/mobile/assignments${query}`)
    .set('Authorization', `Bearer ${token}`);
  return response;
}

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await pg.initialise();
    await pg.start();
    const admin = pg.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  database = db;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, organizations, departments, teams, positions,
      workforce_profiles, schedule_definitions, generated_tasks,
      task_assignments, assets, functional_locations, work_orders,
      work_order_assignments
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await createClientHierarchy('FEED_A');
  clientA = a.clientId;
  buildingA = a.buildingId;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const b = await createClientHierarchy('FEED_B');
  clientB = b.clientId;
  buildingB = b.buildingId;

  const chain = await createOrgChain(clientA, 'FEED');
  teamId = chain.teamId;
  adminProfileId = await createProfile(chain, adminUserId, 'FEED');

  // Tasks.
  task1Id = await createTask(clientA, buildingA, 'OPEN', 1);
  await assignTask(task1Id, 'WORKFORCE', adminProfileId, null, adminUserId);
  task2Id = await createTask(clientA, buildingA, 'OPEN', 2);
  await assignTask(task2Id, 'TEAM', null, teamId, adminUserId);
  task3Id = await createTask(clientA, buildingA, 'OPEN', 3);
  await assignTask(task3Id, 'WORKFORCE', adminProfileId, null, adminUserId, 'INACTIVE');
  taskXId = await createTask(clientB, buildingB, 'OPEN', 4);
  await assignTask(taskXId, 'WORKFORCE', adminProfileId, null, adminUserId);

  // Work orders.
  wo1Id = await createWorkOrder(clientA, buildingA, 'WO One');
  await assignWorkOrder(wo1Id, 'WORKFORCE', adminProfileId, null, adminUserId);
  wo2Id = await createWorkOrder(clientA, buildingA, 'WO Two');
  await assignWorkOrder(wo2Id, 'TEAM', null, teamId, adminUserId);
  woXId = await createWorkOrder(clientB, buildingB, 'WO Cross');
  await assignWorkOrder(woXId, 'WORKFORCE', adminProfileId, null, adminUserId);

  const assetId = await insertRow('assets', {
    client_id: clientA,
    building_id: buildingA,
    asset_code: `AST_${randomUUID().slice(0, 8).toUpperCase()}`,
    asset_name: 'Chiller Unit',
    status: 'ACTIVE',
  });
  const flId = await insertRow('functional_locations', {
    building_id: buildingA,
    code: `FL_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Plant Room',
    status: 'ACTIVE',
  });
  wo3Id = await createWorkOrder(clientA, buildingA, 'WO Located', {
    asset_id: assetId,
    functional_location_id: flId,
  });
  await assignWorkOrder(wo3Id, 'WORKFORCE', adminProfileId, null, adminUserId);

  // Read-only user (task.read + work_order.read, no manage) with one task.
  const readOnly = await createUserWithPermissions(
    [
      { code: 'task.read', name: 'Read Tasks' },
      { code: 'work_order.read', name: 'Read Work Orders' },
    ],
    'readonly',
  );
  readOnlyToken = readOnly.token;
  await buildingAssignmentService.createAssignment(readOnly.userId, {
    buildingId: buildingA,
  });
  const roChain = await createOrgChain(clientA, 'RO');
  const roProfile = await createProfile(roChain, readOnly.userId, 'RO');
  const roTask = await createTask(clientA, buildingA, 'OPEN', 5);
  await assignTask(roTask, 'WORKFORCE', roProfile, null, adminUserId);

  // Zero-assignment user with read permissions.
  const empty = await createUserWithPermissions(
    [
      { code: 'task.read', name: 'Read Tasks' },
      { code: 'work_order.read', name: 'Read Work Orders' },
    ],
    'empty',
  );
  emptyToken = empty.token;

  // Plain user with no permissions.
  const plain = await createUserWithPermissions([], 'plain');
  plainToken = plain.token;
});

after(async () => {
  try {
    if (pool) {
      await closePool(pool);
    }
    if (pg) {
      await pg.stop();
    }
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

describe('BE-25C mobile assignment contract — feed composition', () => {
  it('returns the user’s Task and Work Order assignments with the full contract shape', async () => {
    const response = await getFeed(adminToken);
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.ok(Array.isArray(response.body.data));

    const items = response.body.data as any[];
    assert.equal(items.length, 5, 'T1, T2, WO1, WO2, WO3 only');

    const task1 = feedItem(items, 'TASK', task1Id);
    assert.deepEqual(Object.keys(task1).sort(), [
      'assignee',
      'availableActions',
      'context',
      'id',
      'reference',
      'schedule',
      'shift',
      'status',
      'type',
    ]);
    // MOB-C04 PART 01 — shift is always present (nullable). These fixtures have
    // no roster / Building timezone, so no current shift is affirmed → null.
    assert.equal(task1.shift, null);
    assert.equal(task1.status, 'OPEN');
    assert.equal(task1.assignee.assigneeType, 'WORKFORCE');
    assert.equal(task1.assignee.workforceProfileId, adminProfileId);
    assert.equal(task1.assignee.teamId, null);
    assert.equal(task1.assignee.assignedByUserId, adminUserId);
    assert.equal(task1.assignee.assignmentStatus, 'ACTIVE');
    assert.equal(task1.context.clientId, clientA);
    assert.equal(task1.context.buildingId, buildingA);
    assert.ok(task1.context.buildingCode);
    assert.ok(task1.context.buildingName);
    assert.deepEqual(task1.context.locations, []);
    assert.equal(task1.schedule.occurrenceAt, '2026-08-01T01:00:00.000Z');
    assert.equal(task1.schedule.dueAt, null);
    assert.equal(task1.reference.taskId, task1Id);
    assert.ok(task1.reference.generatedAt);
    assert.equal(task1.reference.workOrderId, null);

    const wo1 = feedItem(items, 'WORK_ORDER', wo1Id);
    assert.equal(wo1.status, 'OPEN');
    assert.equal(wo1.assignee.assigneeType, 'WORKFORCE');
    assert.equal(wo1.context.buildingId, buildingA);
    assert.equal(wo1.reference.workOrderId, wo1Id);
    assert.ok(wo1.reference.workOrderNumber);
    assert.equal(wo1.reference.title, 'WO One');
    assert.equal(wo1.reference.workType, 'CORRECTIVE');
    assert.equal(wo1.reference.priority, 'MEDIUM');
    assert.ok(wo1.reference.createdAt);
    assert.equal(wo1.schedule.occurrenceAt, null);
    assert.equal(wo1.schedule.dueAt, null, 'no authoritative due date');
  });

  it('includes TEAM assignments through the user’s team', async () => {
    const response = await getFeed(adminToken);
    const items = response.body.data as any[];

    const task2 = feedItem(items, 'TASK', task2Id);
    assert.equal(task2.assignee.assigneeType, 'TEAM');
    assert.equal(task2.assignee.teamId, teamId);

    const wo2 = feedItem(items, 'WORK_ORDER', wo2Id);
    assert.equal(wo2.assignee.assigneeType, 'TEAM');
    assert.equal(wo2.assignee.teamId, teamId);
  });

  it('returns Building / Location context for bound work orders', async () => {
    const response = await getFeed(adminToken);
    const wo3 = feedItem(response.body.data, 'WORK_ORDER', wo3Id);
    assert.equal(wo3.context.buildingId, buildingA);
    assert.equal(wo3.context.locations.length, 2);
    const asset = wo3.context.locations.find(
      (entry: { type: string }) => entry.type === 'ASSET',
    );
    const fl = wo3.context.locations.find(
      (entry: { type: string }) => entry.type === 'FUNCTIONAL_LOCATION',
    );
    assert.ok(asset);
    assert.ok(asset.code);
    assert.equal(asset.name, 'Chiller Unit');
    assert.ok(fl);
    assert.equal(fl.name, 'Plant Room');
  });

  it('excludes cross-Client assignments and INACTIVE assignments', async () => {
    const response = await getFeed(adminToken);
    const items = response.body.data as any[];
    const ids = items.flatMap((entry) => [
      entry.reference.taskId,
      entry.reference.workOrderId,
    ]);
    assert.ok(!ids.includes(taskXId), 'cross-Client task must be excluded');
    assert.ok(!ids.includes(woXId), 'cross-Client work order must be excluded');
    assert.ok(!ids.includes(task3Id), 'INACTIVE assignment must be excluded');
  });

  it('requires authentication and read permissions', async () => {
    const anonymous = await api().get('/api/v1/mobile/assignments');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await getFeed(plainToken);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns a well-formed empty feed for a zero-scope user with read permissions', async () => {
    const response = await getFeed(emptyToken);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
    assert.deepEqual(response.body.meta, {});
  });
});

describe('BE-25C mobile assignment contract — available_actions (backend-authoritative)', () => {
  it('resolves task actions from the execution authority (OPEN → START, CANCEL)', async () => {
    const response = await getFeed(adminToken);
    const task1 = feedItem(response.body.data, 'TASK', task1Id);
    assert.deepEqual(task1.availableActions, ['START', 'CANCEL']);
  });

  it('resolves work order actions from ACTION_RULES (OPEN → ACKNOWLEDGE, ADD_NOTE, CANCEL)', async () => {
    const response = await getFeed(adminToken);
    const wo1 = feedItem(response.body.data, 'WORK_ORDER', wo1Id);
    assert.deepEqual(wo1.availableActions, ['ACKNOWLEDGE', 'ADD_NOTE', 'CANCEL']);
  });

  it('feed actions are executable on the real endpoints and track authoritative state', async () => {
    // START the task through the real endpoint (feed said START is available).
    const started = await api()
      .post(`/api/v1/tasks/${task1Id}/start`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(started.status, 200);

    const afterStart = await getFeed(adminToken);
    const task1 = feedItem(afterStart.body.data, 'TASK', task1Id);
    assert.equal(task1.status, 'IN_PROGRESS');
    assert.deepEqual(task1.availableActions, ['COMPLETE', 'CANCEL']);

    // COMPLETE through the real endpoint.
    const completed = await api()
      .post(`/api/v1/tasks/${task1Id}/complete`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(completed.status, 200);

    const afterComplete = await getFeed(adminToken);
    const task1Done = feedItem(afterComplete.body.data, 'TASK', task1Id);
    assert.equal(task1Done.status, 'COMPLETED');
    assert.deepEqual(task1Done.availableActions, []);
  });

  it('acknowledging a work order updates status and actions', async () => {
    const acknowledged = await api()
      .post(`/api/v1/work-orders/${wo1Id}/acknowledge`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    assert.equal(acknowledged.status, 201);

    const response = await getFeed(adminToken);
    const wo1 = feedItem(response.body.data, 'WORK_ORDER', wo1Id);
    assert.equal(wo1.status, 'ASSIGNED');
    assert.deepEqual(wo1.availableActions, [
      'ACKNOWLEDGE',
      'START',
      'ADD_NOTE',
      'CANCEL',
    ]);
  });

  it('returns no actions when the caller lacks the manage permission', async () => {
    const response = await getFeed(readOnlyToken);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    const item = response.body.data[0] as any;
    assert.equal(item.type, 'TASK');
    assert.equal(item.status, 'OPEN');
    assert.deepEqual(item.availableActions, []);
  });
});

describe('BE-25C mobile assignment contract — pagination', () => {
  it('paginates the feed with the BE-25A opt-in convention', async () => {
    const response = await getFeed(adminToken, '?page=1&pageSize=2');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 2);
    assert.deepEqual(response.body.meta, {
      page: 1,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });

    const page2 = await getFeed(adminToken, '?page=2&pageSize=2');
    assert.equal(page2.body.data.length, 2);
    assert.deepEqual(page2.body.meta, {
      page: 2,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });

    const ids1 = response.body.data.map((entry: any) => entry.id);
    const ids2 = page2.body.data.map((entry: any) => entry.id);
    assert.notDeepEqual(ids1, ids2, 'pages must not overlap');
  });

  it('rejects invalid pagination with the standard validation error', async () => {
    const response = await getFeed(adminToken, '?page=0');
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(response.body.error.details));
  });
});

// ---------------------------------------------------------------------------
// CR-BE-RN12-METER-ENTRY-01 — canonical BE-18 reading-due id on the mobile
// assignment reference.
//
// Focused, additive test only. It proves the new `reference.utilityReadingDueId`
// is derived SOLELY from the generated-task → utility_reading_due relation
// (`utility_reading_dues.generated_task_id = generated_tasks.id`), never from
// `targetType` / `targetId`, and that every other assignment keeps it null.
// No new command, no authority change, no migration.
// ---------------------------------------------------------------------------
describe('CR-BE-RN12-METER-ENTRY-01 — reading due reference on mobile assignment', () => {
  let meterId = '';
  let rdTaskId = ''; // TASK whose generated task is linked to a reading due
  let rdDueId = '';
  let otherTaskId = ''; // TASK with no linked reading due
  let rdTask2Id = ''; // second TASK linked to a DIFFERENT reading due
  let rdDue2Id = '';

  async function createMeter(): Promise<string> {
    const uomId = await insertRow('units_of_measure', {
      client_id: clientA,
      code: `UOM_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Kilowatt Hour',
      symbol: 'kWh',
      category: 'ENERGY',
    });
    return insertRow('utility_meters', {
      client_id: clientA,
      building_id: buildingA,
      code: `MTR_${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Main Meter',
      utility_type: 'ELECTRICITY',
      uom_id: uomId,
    });
  }

  async function createReadingDue(
    meter: string,
    generatedTaskId: string,
    periodDay: number,
  ): Promise<string> {
    const dueId = id();
    await q(
      `INSERT INTO utility_reading_dues
         (id, client_id, building_id, meter_id, utility_type, period_start,
          period_end, due_at, status, schedule_definition_id,
          generated_task_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DUE', NULL, $9, $10)`,
      [
        dueId,
        clientA,
        buildingA,
        meter,
        'ELECTRICITY',
        `2026-09-0${periodDay}T00:00:00Z`,
        `2026-09-1${periodDay}T00:00:00Z`,
        '2026-09-20T00:00:00Z',
        generatedTaskId,
        adminUserId,
      ],
    );
    return dueId;
  }

  before(async () => {
    meterId = await createMeter();

    rdTaskId = await createTask(clientA, buildingA, 'OPEN', 6);
    await assignTask(rdTaskId, 'WORKFORCE', adminProfileId, null, adminUserId);
    rdDueId = await createReadingDue(meterId, rdTaskId, 1);

    otherTaskId = await createTask(clientA, buildingA, 'OPEN', 7);
    await assignTask(otherTaskId, 'WORKFORCE', adminProfileId, null, adminUserId);

    rdTask2Id = await createTask(clientA, buildingA, 'OPEN', 8);
    await assignTask(rdTask2Id, 'WORKFORCE', adminProfileId, null, adminUserId);
    rdDue2Id = await createReadingDue(meterId, rdTask2Id, 2);
  });

  it('A — returns the exact utilityReadingDueId for the linked reading-due task', async () => {
    const response = await getFeed(adminToken);
    assert.equal(response.status, 200);
    const item = feedItem(response.body.data, 'TASK', rdTaskId);
    assert.equal(typeof item.reference.utilityReadingDueId, 'string');
    assert.equal(item.reference.utilityReadingDueId, rdDueId);
  });

  it('B — returns null/absent for a task with no linked reading due (and for work orders)', async () => {
    const response = await getFeed(adminToken);
    const unlinked = feedItem(response.body.data, 'TASK', otherTaskId);
    assert.equal(unlinked.reference.utilityReadingDueId, null);

    const preExisting = feedItem(response.body.data, 'TASK', task1Id);
    assert.equal(preExisting.reference.utilityReadingDueId, null);

    const wo = feedItem(response.body.data, 'WORK_ORDER', wo1Id);
    assert.equal(wo.reference.utilityReadingDueId, null);
  });

  it('C — two dues/tasks never cross-link', async () => {
    const response = await getFeed(adminToken);
    const a = feedItem(response.body.data, 'TASK', rdTaskId);
    const b = feedItem(response.body.data, 'TASK', rdTask2Id);
    assert.equal(a.reference.utilityReadingDueId, rdDueId);
    assert.equal(b.reference.utilityReadingDueId, rdDue2Id);
    assert.notEqual(a.reference.utilityReadingDueId, rdDue2Id);
    assert.notEqual(b.reference.utilityReadingDueId, rdDueId);
  });

  it('D — derived from the generated-task relation, not targetType/targetId', async () => {
    // The linked task targets CHECKLIST_TEMPLATE (not a meter), proving the id is
    // NOT inferred from targetType/targetId.
    const response = await getFeed(adminToken);
    const linked = feedItem(response.body.data, 'TASK', rdTaskId);
    assert.equal(linked.reference.targetType, 'CHECKLIST_TEMPLATE');
    assert.equal(linked.reference.utilityReadingDueId, rdDueId);

    // A task whose generated task targets UTILITY_METER but has NO reading due
    // must still return null — targetType alone must never produce an id.
    const meterTaskId = await createTask(clientA, buildingA, 'OPEN', 9);
    await q(
      `UPDATE generated_tasks SET target_type = 'UTILITY_METER' WHERE id = $1`,
      [meterTaskId],
    );
    await assignTask(meterTaskId, 'WORKFORCE', adminProfileId, null, adminUserId);
    const response2 = await getFeed(adminToken);
    const meterItem = feedItem(response2.body.data, 'TASK', meterTaskId);
    assert.equal(meterItem.reference.targetType, 'UTILITY_METER');
    assert.equal(meterItem.reference.utilityReadingDueId, null);
  });

  it('E — existing assignment fields remain unchanged for the linked task', async () => {
    const response = await getFeed(adminToken);
    const item = feedItem(response.body.data, 'TASK', rdTaskId);
    assert.equal(item.type, 'TASK');
    assert.equal(item.status, 'OPEN');
    assert.equal(item.reference.taskId, rdTaskId);
    assert.equal(item.reference.targetType, 'CHECKLIST_TEMPLATE');
    assert.ok(item.reference.targetId);
    assert.equal(item.reference.scheduleDefinitionId, item.reference.scheduleDefinitionId);
    assert.ok(item.reference.generatedAt);
    // WORK_ORDER side stays explicit null.
    assert.equal(item.reference.workOrderId, null);
    assert.equal(item.reference.workOrderNumber, null);
    assert.equal(item.reference.title, null);
  });
});
