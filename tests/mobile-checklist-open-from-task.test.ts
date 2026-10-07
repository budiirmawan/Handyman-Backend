import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
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
import { assignShiftToWorkforce } from '../src/modules/workforce-shifts';
import {
  openChecklistExecutionForTask,
  executeMobileChecklistStart,
} from '../src/modules/mobile-checklist';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C04 PART 02B — Authoritative task → checklist-execution creation.
 *
 * Proves the smallest backend-authoritative flow that opens (get-or-create)
 * the bound checklist execution for an executable generated task:
 *   1. assigned + current-shift worker creates the bound execution,
 *   2. created row carries the exact generated_task_id,
 *   3. the exact template comes from the task's target_id,
 *   4. a repeated request returns the SAME execution (idempotent),
 *   5. concurrency cannot create duplicates (unique partial index),
 *   6. wrong/unassigned worker rejected,
 *   7. off-shift worker rejected,
 *   8. inaccessible Building rejected,
 *   9. non-CHECKLIST_TEMPLATE task rejected,
 *  10. invalid/deleted template rejected,
 *  11. arbitrary client templateId/buildingId cannot redirect authority,
 *  12. an existing standalone (unbound) execution is not hijacked,
 *  13. the resulting execution works with the mobile shift-locked start,
 *  14. generic Web/admin standalone execution remains unchanged.
 */

const DB_PORT = 55491;
const DATA_DIR = '/tmp/asentra-mob-c04-p2b-pg';
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
let adminToken = '';
let workerUserId = '';
let workerToken = '';
let workerProfileId = '';
let otherWorkerProfileId = '';

let clientA = '';
let buildingA = ''; // accessible + worker on shift
let buildingB = ''; // accessible to other worker only (or unassigned)

let templateActive = '';
let itemCheck = '';
let itemNumber = '';
let standaloneTemplate = '';

let checklistTaskA = ''; // templateActive, building A, assigned to worker
let otherWorkerTask = ''; // templateActive, building A, assigned to other worker
let inaccessibleTask = ''; // templateActive, building B (worker not in scope)
let nonChecklistTask = ''; // FORM_TEMPLATE target, building A
let invalidTemplateTask = ''; // CHECKLIST_TEMPLATE → nonexistent template, building A

const TZ = 'Asia/Jakarta';
const ON_SHIFT = new Date('2026-08-20T02:00:00Z'); // 09:00 Jakarta (07–15 window)
const OFF_SHIFT = new Date('2026-08-20T09:00:00Z'); // 16:00 Jakarta (outside)

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

async function createUser(
  prefix: string,
  codes: { code: string; name: string }[],
): Promise<{ userId: string; token: string }> {
  const password = 'OpenPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Open User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Open Role',
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
  return { userId: user.id, token: login.body.data.sessionToken as string };
}

async function buildProfile(
  userId: string,
  orgId: string,
  deptId: string,
  positionId: string,
): Promise<string> {
  const profile = await workforceService.createWorkforceProfile({
    organizationId: orgId,
    departmentId: deptId,
    positionId: positionId,
    userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Open Worker',
  });
  return profile.id;
}

async function templateWithItems(
  clientId: string,
): Promise<{ templateId: string; itemCheck: string; itemNumber: string }> {
  const templateId = await insertRow('checklist_templates', {
    client_id: clientId,
    code: `TPL_${suffix()}`,
    name: 'Open Checklist',
    status: 'ACTIVE',
  });
  const itemCheck = await insertRow('checklist_items', {
    checklist_template_id: templateId,
    code: 'CHK',
    label: 'Check',
    item_type: 'CHECK',
    required: true,
    display_order: 0,
    status: 'ACTIVE',
  });
  const itemNumber = await insertRow('checklist_items', {
    checklist_template_id: templateId,
    code: 'NUM',
    label: 'Number',
    item_type: 'NUMBER',
    required: true,
    display_order: 1,
    status: 'ACTIVE',
  });
  return { templateId, itemCheck, itemNumber };
}

async function createGeneratedTask(
  clientId: string,
  buildingId: string,
  targetType: string,
  targetId: string,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${suffix()}`,
    name: 'Open schedule',
    target_type: targetType,
    target_id: targetId,
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: TZ,
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-05T01:00:00Z',
    target_type: targetType,
    target_id: targetId,
    building_id: buildingId,
    status: 'OPEN',
  });
}

async function assignToProfile(taskId: string, profileId: string): Promise<void> {
  await insertRow('task_assignments', {
    task_id: taskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: profileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
}

async function countExecutionsForTask(taskId: string): Promise<number> {
  const result = await q(
    'SELECT count(*)::int AS n FROM checklist_executions WHERE generated_task_id = $1',
    [taskId],
  );
  return result.rows[0].n as number;
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
      workforce_profiles, shifts, workforce_shift_assignments,
      schedule_definitions, generated_tasks, task_assignments,
      checklist_templates, checklist_items, checklist_item_responses,
      checklist_executions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

  // Client A with buildings A (worker on shift) and B.
  const a = await clientService.createClient({
    code: `CA_${suffix()}`,
    name: 'Client A',
  });
  clientA = a.id;
  const propA = await propertyService.createProperty({
    clientId: clientA,
    code: `PA_${suffix()}`,
    name: 'Prop A',
  });
  const bA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BA_${suffix()}`,
    name: 'Building A',
    timezone: TZ,
  });
  buildingA = bA.id;
  const bB = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BB_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });
  buildingB = bB.id;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });

  const org = await organizationService.createOrganization({
    clientId: clientA,
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
    code: `P_${suffix()}`,
    name: 'Field Worker',
  });

  // Worker: accessible to A + B, roster at A only, checklist.manage.
  const worker = await createUser(
    'wopen',
    [
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'checklist.manage', name: 'Manage Checklists' },
      { code: 'task.read', name: 'Read Tasks' },
      { code: 'work_order.read', name: 'Read Work Orders' },
    ],
  );
  workerUserId = worker.userId;
  workerToken = worker.token;
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingA,
  });
  // NOTE: the worker is NOT granted building B — an out-of-scope task in B is
  // the inaccessible-building case below.
  workerProfileId = await buildProfile(worker.userId, org.id, dept.id, position.id);

  // Other worker: accessible to A + B, roster at A, but holds no assignment
  // for the worker's checklist task.
  const other = await createUser(
    'oopen',
    [
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'checklist.manage', name: 'Manage Checklists' },
    ],
  );
  await buildingAssignmentService.createAssignment(other.userId, {
    buildingId: buildingA,
  });
  otherWorkerProfileId = await buildProfile(other.userId, org.id, dept.id, position.id);

  // Both on shift at building A (07:00–15:00 Asia/Jakarta).
  const shiftA = await shiftService.createShift({
    clientId: clientA,
    buildingId: buildingA,
    code: `S_${suffix()}`,
    name: 'Morning',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  await assignShiftToWorkforce({
    workforceProfileId: workerProfileId,
    shiftId: shiftA.id,
  });
  await assignShiftToWorkforce({
    workforceProfileId: otherWorkerProfileId,
    shiftId: shiftA.id,
  });

  // Active checklist template + items.
  const t = await templateWithItems(clientA);
  templateActive = t.templateId;
  itemCheck = t.itemCheck;
  itemNumber = t.itemNumber;
  // Standalone template for generic Web/admin test.
  const ts = await templateWithItems(clientA);
  standaloneTemplate = ts.templateId;

  // Tasks.
  checklistTaskA = await createGeneratedTask(
    clientA,
    buildingA,
    'CHECKLIST_TEMPLATE',
    templateActive,
  );
  await assignToProfile(checklistTaskA, workerProfileId);

  otherWorkerTask = await createGeneratedTask(
    clientA,
    buildingA,
    'CHECKLIST_TEMPLATE',
    templateActive,
  );
  await assignToProfile(otherWorkerTask, otherWorkerProfileId);

  inaccessibleTask = await createGeneratedTask(
    clientA,
    buildingB,
    'CHECKLIST_TEMPLATE',
    templateActive,
  );
  await assignToProfile(inaccessibleTask, workerProfileId);

  nonChecklistTask = await createGeneratedTask(
    clientA,
    buildingA,
    'FORM_TEMPLATE',
    id(), // arbitrary non-checklist target id
  );
  await assignToProfile(nonChecklistTask, workerProfileId);

  invalidTemplateTask = await createGeneratedTask(
    clientA,
    buildingA,
    'CHECKLIST_TEMPLATE',
    id(), // no checklist template with this id
  );
  await assignToProfile(invalidTemplateTask, workerProfileId);
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

describe('MOB-C04 PART 02B — task → checklist-execution open flow', () => {
  it('assigned + current-shift worker creates a bound execution', async (t) => {
    if (!ready(t)) return;
    const row = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.status, 'DRAFT');
    assert.ok(row.generated_task_id);
  });

  it('created row carries the exact generated_task_id', async (t) => {
    if (!ready(t)) return;
    const row = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.generated_task_id, checklistTaskA);
  });

  it('the exact checklist template comes from the task target_id', async (t) => {
    if (!ready(t)) return;
    const row = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.checklist_template_id, templateActive);
  });

  it('a repeated request returns the SAME execution (idempotent get-or-create)', async (t) => {
    if (!ready(t)) return;
    const first = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    const second = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(second.id, first.id);
    assert.equal(await countExecutionsForTask(checklistTaskA), 1);
  });

  it('concurrent get-or-create never duplicates (unique partial index backstop)', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'CHECKLIST_TEMPLATE',
      templateActive,
    );
    await assignToProfile(taskId, workerProfileId);
    const results = await Promise.all([
      openChecklistExecutionForTask(taskId, workerUserId, ON_SHIFT),
      openChecklistExecutionForTask(taskId, workerUserId, ON_SHIFT),
      openChecklistExecutionForTask(taskId, workerUserId, ON_SHIFT),
    ]);
    const uniqueIds = new Set(results.map((r) => r.id));
    assert.equal(uniqueIds.size, 1, 'all concurrent calls return the same execution');
    assert.equal(await countExecutionsForTask(taskId), 1);
  });

  it('a different worker not assigned to the task is rejected', async (t) => {
    if (!ready(t)) return;
    // Create an unassigned-at-executor task for a third-party-like check: the
    // other worker holds otherWorkerTask; try to open the worker's task with a
    // real other-worker USER session via the service (userId).
    const otherUserId = await q(
      'SELECT user_id FROM workforce_profiles WHERE id = $1',
      [otherWorkerProfileId],
    ).then((r) => r.rows[0].user_id as string);
    const code = await errorCodeOf(
      openChecklistExecutionForTask(checklistTaskA, otherUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('off-shift worker is rejected', async (t) => {
    if (!ready(t)) return;
    // A task assigned to the worker but opened OFF shift (16:00 Jakarta).
    const offTask = await createGeneratedTask(
      clientA,
      buildingA,
      'CHECKLIST_TEMPLATE',
      templateActive,
    );
    await assignToProfile(offTask, workerProfileId);
    const code = await errorCodeOf(
      openChecklistExecutionForTask(offTask, workerUserId, OFF_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('an inaccessible Building task is rejected', async (t) => {
    if (!ready(t)) return;
    // inaccessibleTask is in building B, which is NOT in the worker's BE-02G
    // accessible set → rejected.
    const code = await errorCodeOf(
      openChecklistExecutionForTask(inaccessibleTask, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('a non-CHECKLIST_TEMPLATE task is rejected', async (t) => {
    if (!ready(t)) return;
    const code = await errorCodeOf(
      openChecklistExecutionForTask(nonChecklistTask, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'BAD_REQUEST');
  });

  it('an invalid/deleted template target is rejected', async (t) => {
    if (!ready(t)) return;
    const code = await errorCodeOf(
      openChecklistExecutionForTask(invalidTemplateTask, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'BAD_REQUEST');
  });

  it('arbitrary client templateId/buildingId cannot redirect authority (HTTP)', async (t) => {
    if (!ready(t)) return;
    // Create a second active template NOT targeted by checklistTaskA; send it
    // as a query/body hint — the backend must ignore it and bind the task's own
    // template.
    const decoy = await templateWithItems(clientA);
    const response = await api()
      .post(
        `/api/v1/mobile/tasks/${checklistTaskA}/checklist-execution?buildingId=${buildingB}`,
      )
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ templateId: decoy.templateId, shiftId: 'anything' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.generatedTaskId, checklistTaskA);
    assert.equal(response.body.data.checklistTemplateId, templateActive);
    assert.notEqual(response.body.data.checklistTemplateId, decoy.templateId);
  });

  it('an existing standalone (unbound) execution is not hijacked', async (t) => {
    if (!ready(t)) return;
    // A standalone unbound execution for the same template exists.
    const standaloneExec = await insertRow('checklist_executions', {
      client_id: clientA,
      checklist_template_id: templateActive,
      status: 'DRAFT',
    });
    const bound = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    // The standalone remains unbound; the open created/returned a distinct
    // bound execution rather than attaching the standalone by template.
    const standaloneCheck = await q(
      'SELECT generated_task_id FROM checklist_executions WHERE id = $1',
      [standaloneExec],
    );
    assert.equal(standaloneCheck.rows[0].generated_task_id, null);
    assert.ok(bound.generated_task_id);
  });

  it('the resulting execution works with the mobile shift-locked start', async (t) => {
    if (!ready(t)) return;
    const bound = await openChecklistExecutionForTask(
      checklistTaskA,
      workerUserId,
      ON_SHIFT,
    );
    const row = await executeMobileChecklistStart(
      bound.id,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.status, 'IN_PROGRESS');
  });

  it('generic Web/admin standalone execution remains unchanged', async (t) => {
    if (!ready(t)) return;
    const created = await api()
      .post(`/api/v1/checklist-templates/${standaloneTemplate}/executions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const executionId = created.body.data.id;
    const started = await api()
      .post(`/api/v1/checklist-executions/${executionId}/start`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'IN_PROGRESS');
  });
});
