import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
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
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { positionService } from '../src/modules/positions';
import { workforceService } from '../src/modules/workforce';
import { shiftService } from '../src/modules/shifts';
import { securityPostService } from '../src/modules/security-posts';
import {
  assignSecurityPostToWorkforceShift,
  assignShiftToWorkforce,
} from '../src/modules/workforce-shifts';
import { mobileAssignmentService } from '../src/modules/mobile-assignments';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C04 PART 01 — Shift-bound field-work feed focused validation.
 *
 * Proves that GET /mobile/assignments:
 *   - returns only the authenticated worker's own accessible work,
 *   - enforces building-level isolation (BE-02G) as the ONLY scope authority,
 *   - annotates each item with the authoritative current-shift context when
 *     the work's Building is the Building the worker is currently on shift at
 *     (reused from /mobile/current-shift), never a client-computed flag,
 *   - keeps `shift: null` (item still returned) when no current shift maps,
 *   - returns a well-formed empty feed for a user with no assignments,
 *   - never accepts a client-selected building/client as authority.
 */

const DB_PORT = 55462;
const DATA_DIR = '/tmp/asentra-mob-c04-p1-pg';
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

let adminUserId = '';
let workerUserId = '';
let workerToken = '';
let workerProfileId = '';

let clientId = '';
let buildingA = ''; // accessible to the worker; carries the roster/shift
let buildingB = ''; // same client, NOT assigned to the worker (isolation)
let buildingC = ''; // same client, ACCESSIBLE to the worker, but NO roster/shift

let shiftAId = '';
let shiftACode = '';
let rosterAssignmentId = '';
let postAId = '';
let postACode = '';

let taskAId = ''; // building A, WORKFORCE → worker (on-shift building)
let woAId = ''; // building A, WORKFORCE → worker
let taskBId = ''; // building B, WORKFORCE → worker (must be excluded)
let woBId = ''; // building B, WORKFORCE → worker (must be excluded)
let taskCId = ''; // building C, WORKFORCE → worker (accessible but OFF shift)
let woCId = ''; // building C, WORKFORCE → worker (accessible but OFF shift)

// Deterministic instants (Asia/Jakarta = UTC+7):
const ON_SHIFT = new Date('2026-08-20T02:00:00Z'); // 09:00 Jakarta, in 07:00–15:00
const OFF_SHIFT = new Date('2026-08-20T09:00:00Z'); // 16:00 Jakarta, outside window
const TZ = 'Asia/Jakarta';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
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

async function createFeedUser(prefix: string): Promise<{
  token: string;
  userId: string;
}> {
  const codes = [
    { code: 'task.read', name: 'Read Tasks' },
    { code: 'work_order.read', name: 'Read Work Orders' },
  ];
  const password = 'FeedPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Feed Worker',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
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

async function createTask(
  targetBuilding: string,
  clientScope: string,
  status: string,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientScope,
    code: `SD_${suffix()}`,
    name: 'Feed Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: id(),
    building_id: targetBuilding,
    start_at: '2026-08-01T00:00:00Z',
    timezone: TZ,
    status: 'ACTIVE',
  });
  const taskId = await insertRow('generated_tasks', {
    client_id: clientScope,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-01T01:00:00Z',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: scheduleId,
    building_id: targetBuilding,
    status,
  });
  await insertRow('task_assignments', {
    task_id: taskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: workerProfileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
  return taskId;
}

async function createWorkOrder(
  targetBuilding: string,
  clientScope: string,
  title: string,
): Promise<string> {
  const woId = await insertRow('work_orders', {
    client_id: clientScope,
    building_id: targetBuilding,
    work_order_number: `WO-${suffix()}`,
    title,
    work_type: 'CORRECTIVE',
    status: 'OPEN',
    created_by_user_id: adminUserId,
  });
  await insertRow('work_order_assignments', {
    work_order_id: woId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: workerProfileId,
    team_id: null,
    vendor_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
  return woId;
}

function feedItem(items: any[], type: string, idValue: string): any {
  const item = items.find(
    (entry) =>
      entry.type === type &&
      (entry.reference.taskId === idValue ||
        entry.reference.workOrderId === idValue),
  );
  assert.ok(item, `expected ${type} item ${idValue} in feed`);
  return item;
}

/** Default mode (all accessible active assignments). */
async function listItems(userId: string, now: Date): Promise<any[]> {
  const { items } = await mobileAssignmentService.listMobileAssignments(
    userId,
    null,
    { mode: 'default', now },
  );
  return items;
}

/** shift=current projection (now-live current-shift buildings). */
async function listCurrentShiftItems(
  userId: string,
  now: Date,
): Promise<any[]> {
  const { items } = await mobileAssignmentService.listMobileAssignments(
    userId,
    null,
    { mode: 'currentShift', now },
  );
  return items;
}

/** True when the feed contains a TASK item whose authoritative task id matches. */
function hasTask(items: any[], taskId: string): boolean {
  return items.some(
    (item) => item.type === 'TASK' && item.reference.taskId === taskId,
  );
}

/** True when the feed contains a WORK_ORDER item whose work order id matches. */
function hasWorkOrder(items: any[], woId: string): boolean {
  return items.some(
    (item) => item.type === 'WORK_ORDER' && item.reference.workOrderId === woId,
  );
}

/** HTTP shift=current projection (also proves the query selector). */
async function getCurrentShiftFeed(token: string): Promise<any> {
  return api()
    .get('/api/v1/mobile/assignments?shift=current')
    .set('Authorization', `Bearer ${token}`);
}

async function getDefaultFeed(token: string, query = ''): Promise<any> {
  return api()
    .get(`/api/v1/mobile/assignments${query}`)
    .set('Authorization', `Bearer ${token}`);
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
      user_building_assignments, organizations, departments, positions,
      workforce_profiles, security_posts, shifts,
      workforce_shift_assignments, schedule_definitions, generated_tasks,
      task_assignments, work_orders, work_order_assignments
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;

  // Client + two Buildings under the SAME client (so the isolation assertion
  // below is building-level, not client-level).
  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Shift feed client',
  });
  clientId = client.id;
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const bA = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building A',
    timezone: TZ,
  });
  buildingA = bA.id;
  const bB = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });
  buildingB = bB.id;
  // Building C: accessible to the worker but carries NO roster/shift, so the
  // worker is never on shift there (the shift=current off-shift-building case).
  const bC = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building C',
    timezone: TZ,
  });
  buildingC = bC.id;

  // Org → Department → Position → Workforce Profile (owned by the worker).
  const org = await organizationService.createOrganization({
    clientId: client.id,
    code: `O_${suffix()}`,
    name: 'Org',
  });
  const dept = await departmentService.createDepartment({
    organizationId: org.id,
    code: `D_${suffix()}`,
    name: 'Dept',
  });
  const position = await positionService.createPosition({
    organizationId: org.id,
    code: `POS_${suffix()}`,
    name: 'Field Worker',
  });

  // Worker user with task.read + work_order.read, accessible ONLY to building A.
  const worker = await createFeedUser('c04');
  workerToken = worker.token;
  workerUserId = worker.userId;
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingA,
  });
  // Building C is accessible (same isolation floor) but has no roster, so the
  // worker is never on shift there.
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingC,
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: position.id,
    userId: workerUserId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Field Worker',
  });
  workerProfileId = profile.id;

  // Roster: a morning shift at building A + an assigned Security Post.
  const shiftA = await shiftService.createShift({
    clientId: client.id,
    buildingId: buildingA,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  shiftAId = shiftA.id;
  shiftACode = shiftA.code;
  const roster = await assignShiftToWorkforce({
    workforceProfileId: workerProfileId,
    shiftId: shiftA.id,
  });
  rosterAssignmentId = roster.id;
  const postA = await securityPostService.createSecurityPost({
    buildingId: buildingA,
    code: `POST_${suffix()}`,
    name: 'Gate A',
    postType: 'GATE',
  });
  postAId = postA.id;
  postACode = postA.code;
  await assignSecurityPostToWorkforceShift({
    workforceShiftAssignmentId: roster.id,
    securityPostId: postA.id,
  });

  // Work assigned to the worker.
  taskAId = await createTask(buildingA, client.id, 'OPEN');
  woAId = await createWorkOrder(buildingA, client.id, 'WO in A');
  taskBId = await createTask(buildingB, client.id, 'OPEN');
  woBId = await createWorkOrder(buildingB, client.id, 'WO in B');
  taskCId = await createTask(buildingC, client.id, 'OPEN');
  woCId = await createWorkOrder(buildingC, client.id, 'WO in C');
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

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

describe('MOB-C04 PART 01 — shift-bound field work feed', () => {
  it('returns own accessible work annotated with the current shift context', async (t) => {
    if (!ready(t)) return;
    const items = await listItems(workerUserId, ON_SHIFT);

    const taskA = feedItem(items, 'TASK', taskAId);
    assert.equal(taskA.context.buildingId, buildingA);
    // Full DTO has the nullable `shift` key.
    assert.ok(Object.keys(taskA).includes('shift'));
    // On shift at building A → task carries shift context.
    assert.equal(taskA.shift.shiftId, shiftAId);
    assert.equal(taskA.shift.assignmentId, rosterAssignmentId);
    assert.equal(taskA.shift.code, shiftACode);
    assert.equal(taskA.shift.name, 'Morning shift');
    assert.equal(taskA.shift.startTime, '07:00:00');
    assert.equal(taskA.shift.endTime, '15:00:00');
    assert.deepEqual(taskA.shift.securityPost, {
      id: postAId,
      code: postACode,
      name: 'Gate A',
    });

    const woA = feedItem(items, 'WORK_ORDER', woAId);
    assert.equal(woA.shift.shiftId, shiftAId);
    assert.equal(woA.shift.securityPost.id, postAId);
  });

  it('cross-building isolation: assigned work outside the accessible building is excluded', async (t) => {
    if (!ready(t)) return;
    const items = await listItems(workerUserId, ON_SHIFT);
    const ids = items.map((item) => item.id);
    assert.ok(feedItem(items, 'TASK', taskAId));
    assert.ok(feedItem(items, 'WORK_ORDER', woAId));
    // Both a task and a work order are DIRECTLY assigned to the worker but in
    // building B, which is not in the worker's accessible set → excluded.
    assert.ok(!ids.includes(taskBId), 'cross-building task must be excluded');
    assert.ok(!ids.includes(woBId), 'cross-building work order must be excluded');
  });

  it('no current shift → shift is null but the item is still returned', async (t) => {
    if (!ready(t)) return;
    // OFF_SHIFT (16:00 Jakarta) is outside the 07:00–15:00 window.
    const items = await listItems(workerUserId, OFF_SHIFT);
    const taskA = feedItem(items, 'TASK', taskAId);
    assert.equal(taskA.shift, null, 'no current shift at this instant');
    const woA = feedItem(items, 'WORK_ORDER', woAId);
    assert.equal(woA.shift, null);
    // Scope isolation alone never hides assigned + accessible work.
    assert.ok(items.some((i) => i.id === taskA.id));
  });

  it('empty-state: a user with read permissions but no assignments gets an empty feed', async (t) => {
    if (!ready(t)) return;
    const empty = await createFeedUser('c04empty');
    const response = await api()
      .get('/api/v1/mobile/assignments')
      .set('Authorization', `Bearer ${empty.token}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data, []);
    assert.deepEqual(response.body.meta, {});
  });

  it('no client-selected authority: building scope is derived from the session only', async (t) => {
    if (!ready(t)) return;
    // A client supplies a buildingId of an inaccessible building — the backend
    // never adopts it as authority and must not leak that building's work.
    const response = await api()
      .get(`/api/v1/mobile/assignments?buildingId=${buildingB}`)
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const items = response.body.data as any[];
    const ids = items.map((item) => item.id);
    assert.ok(!ids.includes(taskBId), 'inaccessible-building work never leaks');
    assert.ok(!ids.includes(woBId), 'inaccessible-building work order never leaks');
    // Own accessible work (building A) is still returned.
    const taskA = feedItem(items, 'TASK', taskAId);
    assert.equal(taskA.context.buildingId, buildingA);
  });

  it('unauthenticated requests are rejected (401), never 404', async () => {
    const response = await api().get('/api/v1/mobile/assignments');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('MOB-C04 PART 01A — current-shift field work projection (?shift=current)', () => {
  it('default mode still returns accessible off-shift assignments (no redefinition)', async (t) => {
    if (!ready(t)) return;
    // Building C is accessible but the worker is not on shift there — default
    // mode keeps its assigned work (BE-25C is the all-accessible surface).
    const items = await listItems(workerUserId, ON_SHIFT);
    assert.ok(hasTask(items, taskAId), 'on-shift building work present');
    assert.ok(
      hasTask(items, taskCId),
      'accessible off-shift building work present in default mode',
    );
    assert.ok(hasWorkOrder(items, woAId));
    const taskC = feedItem(items, 'TASK', taskCId);
    assert.equal(taskC.shift, null, 'off-shift building annotated null in default');
    const taskA = feedItem(items, 'TASK', taskAId);
    assert.equal(taskA.shift.shiftId, shiftAId, 'on-shift building annotated');
  });

  it('shift=current returns only assignments in the current-shift building', async (t) => {
    if (!ready(t)) return;
    const items = await listCurrentShiftItems(workerUserId, ON_SHIFT);
    assert.ok(hasTask(items, taskAId), 'on-shift building work returned');
    assert.ok(hasWorkOrder(items, woAId), 'on-shift building WO returned');
    // The wire selector is accepted and returns a well-formed feed array
    // (clock-independent shape check; membership is asserted above).
    const http = await getCurrentShiftFeed(workerToken);
    assert.equal(http.status, 200, JSON.stringify(http.body));
    assert.equal(http.body.success, true);
    assert.ok(Array.isArray(http.body.data));
  });

  it('off-shift-building work is excluded from shift=current', async (t) => {
    if (!ready(t)) return;
    const items = await listCurrentShiftItems(workerUserId, ON_SHIFT);
    assert.ok(hasTask(items, taskAId));
    assert.ok(hasWorkOrder(items, woAId));
    // Building C is ACCESSIBLE but the worker is not on shift there → excluded
    // from the current-shift projection (while present in default mode).
    assert.ok(!hasTask(items, taskCId), 'off-shift-building task excluded');
    assert.ok(!hasWorkOrder(items, woCId), 'off-shift-building work order excluded');
  });

  it('no current shift → shift=current returns an empty feed (no fallback)', async (t) => {
    if (!ready(t)) return;
    // OFF_SHIFT (16:00 Jakarta) is outside the 07:00–15:00 window.
    const items = await listCurrentShiftItems(workerUserId, OFF_SHIFT);
    assert.deepEqual(items, [], 'shift=current must be empty when not on shift');
    // Default mode at the same instant is NOT empty — proves no fallback.
    const defaultItems = await listItems(workerUserId, OFF_SHIFT);
    assert.ok(hasTask(defaultItems, taskAId), 'default still has assigned work');
  });

  it('no current shift returns HTTP 200 with data: []', async (t) => {
    if (!ready(t)) return;
    // A user with no roster is never on shift → shift=current is 200 data: [].
    const empty = await createFeedUser('c04off');
    const http = await getDefaultFeed(empty.token, '?shift=current');
    assert.equal(http.status, 200, JSON.stringify(http.body));
    assert.equal(http.body.success, true);
    assert.deepEqual(http.body.data, []);
  });

  it('default mode still returns assignments when the worker is off shift', async (t) => {
    if (!ready(t)) return;
    const items = await listItems(workerUserId, OFF_SHIFT);
    assert.ok(hasTask(items, taskAId), 'default feed still lists assigned work while off shift');
    const taskA = feedItem(items, 'TASK', taskAId);
    assert.equal(taskA.shift, null);
  });

  it('cross-building inaccessible work is excluded in both modes', async (t) => {
    if (!ready(t)) return;
    const defaultItems = await listItems(workerUserId, ON_SHIFT);
    const shiftItems = await listCurrentShiftItems(workerUserId, ON_SHIFT);
    for (const items of [defaultItems, shiftItems]) {
      assert.ok(!hasTask(items, taskBId), 'inaccessible task never returned');
      assert.ok(!hasWorkOrder(items, woBId), 'inaccessible work order never returned');
    }
  });

  it('returned shift context remains populated and authoritative in shift=current', async (t) => {
    if (!ready(t)) return;
    const items = await listCurrentShiftItems(workerUserId, ON_SHIFT);
    const taskA = feedItem(items, 'TASK', taskAId);
    assert.equal(taskA.shift.shiftId, shiftAId);
    assert.equal(taskA.shift.assignmentId, rosterAssignmentId);
    assert.equal(taskA.shift.code, shiftACode);
    assert.equal(taskA.shift.name, 'Morning shift');
    assert.equal(taskA.shift.startTime, '07:00:00');
    assert.equal(taskA.shift.endTime, '15:00:00');
    // No item in this projection is ever shift-null.
    assert.ok(items.every((item) => item.shift !== null));
  });

  it('Security Post is context only — no post-based filtering, authoritative summary kept', async (t) => {
    if (!ready(t)) return;
    const items = await listCurrentShiftItems(workerUserId, ON_SHIFT);
    const woA = feedItem(items, 'WORK_ORDER', woAId);
    assert.equal(woA.shift.shiftId, shiftAId);
    assert.deepEqual(woA.shift.securityPost, {
      id: postAId,
      code: postACode,
      name: 'Gate A',
    });
  });

  it('client building/shift parameters cannot expand authority; invalid shift rejected', async (t) => {
    if (!ready(t)) return;
    // Building B is inaccessible to the worker — a client-supplied buildingId
    // must never expand the scope, even combined with shift=current.
    const http = await api()
      .get(`/api/v1/mobile/assignments?shift=current&buildingId=${buildingB}`)
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(http.status, 200, JSON.stringify(http.body));
    const items = http.body.data as any[];
    assert.ok(!hasTask(items, taskBId), 'inaccessible work never leaks');
    assert.ok(!hasWorkOrder(items, woBId));
    // Only shift=current is supported — anything else is a validation error.
    const bad = await api()
      .get('/api/v1/mobile/assignments?shift=bogus')
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    const badArray = await api()
      .get('/api/v1/mobile/assignments?shift=current&shift=current')
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(badArray.status, 400, JSON.stringify(badArray.body));
  });
});
