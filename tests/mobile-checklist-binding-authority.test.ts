import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { migrateDown } from '../src/database/migrate';
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
  assertMobileChecklistExecutionCurrentShift,
  executeMobileChecklistStart,
  resolveMobileChecklistWorkContext,
} from '../src/modules/mobile-checklist';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C04 PART 02A — Authoritative checklist-execution → generated-task
 * work binding.
 *
 * Proves the data-model + authoritative-resolution foundation that replaces the
 * ambiguous "first generated task matching the checklist template" lookup:
 *   1. a bound execution resolves its EXACT generated task,
 *   2. a bound execution resolves its EXACT Building,
 *   3. the same template used by tasks in different Buildings never causes
 *      ambiguity (a bound task in Building B resolves B even when a task in
 *      Building A targeting the same template sorts first),
 *   4. an unbound/standalone execution never guesses a task,
 *   5. mobile mutation of an unbound execution FAILS CLOSED,
 *   6. generic Web/admin standalone execution stays backward-compatible,
 *   7. a cross-Client generated-task binding cannot be forged,
 *   8. wrong/unassigned worker is rejected and the assigned worker is accepted
 *      (reusing task-assignment authority),
 *   9. the migration adds the nullable generated_task_id (and down() removes it).
 */

const DB_PORT = 55484;
const DATA_DIR = '/tmp/asentra-mob-c04-p2a-pg';
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
let workerProfileId = '';
let otherWorkerUserId = '';
let otherWorkerProfileId = '';
let teamId = '';

let clientA = '';
let buildingA = '';
let buildingB = '';
let clientB = '';

let templateT = '';
let templateStandalone = '';
let templateCross = '';
let genTaskA = ''; // template T, Building A, EARLIEST occurrence
let genTaskB = ''; // template T, Building B, later occurrence
let itemACheck = '';
let itemANumber = '';

let execBoundToB = ''; // template T execution bound to genTaskB
let execBoundToA = ''; // template T execution bound to genTaskA
let execUnbound = ''; // standalone (no generated_task_id)
let execCrossClient = ''; // client A execution forged-bound to a client B task

const TZ = 'Asia/Jakarta';
const ON_SHIFT = new Date('2026-08-20T02:00:00Z'); // 09:00 Jakarta, in 07:00–15:00

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
  const password = 'BindPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Binding User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Binding Role',
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

/** Builds an org chain + a workforce profile for a user under client A. */
async function buildProfile(
  userId: string,
  prefix: string,
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
    fullName: `${prefix} Worker`,
  });
  return profile.id;
}

/** Creates a checklist template with a CHECK + NUMBER item (clientA). */
async function templateWithItems(
  clientId: string,
): Promise<{ templateId: string; itemCheck: string; itemNumber: string }> {
  const templateId = await insertRow('checklist_templates', {
    client_id: clientId,
    code: `TPL_${suffix()}`,
    name: 'Binding Checklist',
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

/** Creates a generated task for the given template at a building/occurrence. */
async function createGeneratedTask(
  clientId: string,
  templateId: string,
  buildingId: string,
  occurrenceAt: string,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${suffix()}`,
    name: 'Binding schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateId,
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: TZ,
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: occurrenceAt,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateId,
    building_id: buildingId,
    status: 'OPEN',
  });
}

async function bindExecution(
  executionId: string,
  taskId: string,
): Promise<void> {
  await q('UPDATE checklist_executions SET generated_task_id = $1 WHERE id = $2', [
    taskId,
    executionId,
  ]);
}

/** Creates a checklist execution (optionally unbound) under a client. */
async function createUnboundExecution(
  clientId: string,
  templateId: string,
): Promise<string> {
  return insertRow('checklist_executions', {
    client_id: clientId,
    checklist_template_id: templateId,
    status: 'DRAFT',
  });
}

async function assignTaskToProfile(
  taskId: string,
  profileId: string,
): Promise<void> {
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
      workforce_profiles, teams, shifts, workforce_shift_assignments,
      schedule_definitions, generated_tasks, task_assignments,
      checklist_templates, checklist_items, checklist_item_responses,
      checklist_executions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

  // Client A + buildings A & B (worker accessible to both, on shift at A only).
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
  // Admin needs an accessible building to create/start generic executions.
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA,
  });
  const bB = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BB_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });
  buildingB = bB.id;

  // Client B (inaccessible to the worker).
  const b = await clientService.createClient({
    code: `CB_${suffix()}`,
    name: 'Client B',
  });
  clientB = b.id;
  const propB = await propertyService.createProperty({
    clientId: clientB,
    code: `PB_${suffix()}`,
    name: 'Prop B',
  });
  const bB2 = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BX_${suffix()}`,
    name: 'Building X',
    timezone: TZ,
  });
  const buildingX = bB2.id;

  // Org chain under client A.
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
  const team = await insertRow('teams', {
    department_id: dept.id,
    code: `TEAM_${suffix()}`,
    name: 'Binding Team',
    status: 'ACTIVE',
  });
  teamId = team;

  // Worker + other worker (both in client A org chain).
  const worker = await createUser(
    'wbind',
    [
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'checklist.manage', name: 'Manage Checklists' },
      { code: 'task.read', name: 'Read Tasks' },
    ],
  );
  workerUserId = worker.userId;
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingA,
  });
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingB,
  });
  workerProfileId = await buildProfile(
    workerUserId,
    'WB',
    org.id,
    dept.id,
    position.id,
  );
  await q('UPDATE workforce_profiles SET team_id = $1 WHERE id = $2', [
    teamId,
    workerProfileId,
  ]);

  const other = await createUser(
    'xbind',
    [
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'checklist.manage', name: 'Manage Checklists' },
    ],
  );
  otherWorkerUserId = other.userId;
  await buildingAssignmentService.createAssignment(otherWorkerUserId, {
    buildingId: buildingA,
  });
  otherWorkerProfileId = await buildProfile(
    other.userId,
    'XW',
    org.id,
    dept.id,
    position.id,
  );

  // Both workers are on shift at building A only (Asia/Jakarta 07:00–15:00),
  // so an assignment-denial can be isolated from an off-shift denial.
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

  // Shared template T targeted by tasks in Building A (earliest) and B.
  const t = await templateWithItems(clientA);
  templateT = t.templateId;
  itemACheck = t.itemCheck;
  itemANumber = t.itemNumber;
  genTaskA = await createGeneratedTask(
    clientA,
    templateT,
    buildingA,
    '2026-08-01T01:00:00Z', // EARLIEST occurrence → template-first lookup would pick this
  );
  genTaskB = await createGeneratedTask(
    clientA,
    templateT,
    buildingB,
    '2026-08-05T01:00:00Z',
  );
  await assignTaskToProfile(genTaskA, workerProfileId);
  await assignTaskToProfile(genTaskB, workerProfileId);

  // Standalone template for generic Web/admin execution.
  const ts = await templateWithItems(clientA);
  templateStandalone = ts.templateId;

  // Executions.
  execBoundToA = await createUnboundExecution(clientA, templateT);
  await bindExecution(execBoundToA, genTaskA);
  execBoundToB = await createUnboundExecution(clientA, templateT);
  await bindExecution(execBoundToB, genTaskB);
  execUnbound = await createUnboundExecution(clientA, ts.templateId);

  // Cross-Client forged binding: a client A execution bound to a client B task.
  const tc = await templateWithItems(clientB);
  templateCross = tc.templateId;
  const genTaskX = await createGeneratedTask(
    clientB,
    templateCross,
    buildingX,
    '2026-08-05T01:00:00Z',
  );
  execCrossClient = await createUnboundExecution(clientA, templateT);
  await bindExecution(execCrossClient, genTaskX);
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

describe('MOB-C04 PART 02A — checklist execution ↔ generated task binding', () => {
  it('a bound execution resolves its EXACT generated task', async (t) => {
    if (!ready(t)) return;
    const ctx = await resolveMobileChecklistWorkContext(
      execBoundToB,
      workerUserId,
    );
    assert.ok(ctx, 'bound execution must resolve work context');
    assert.equal(ctx.taskId, genTaskB);
  });

  it('a bound execution resolves its EXACT Building', async (t) => {
    if (!ready(t)) return;
    const ctx = await resolveMobileChecklistWorkContext(
      execBoundToB,
      workerUserId,
    );
    assert.equal(ctx.buildingId, buildingB);
    const ctxA = await resolveMobileChecklistWorkContext(
      execBoundToA,
      workerUserId,
    );
    assert.equal(ctxA.buildingId, buildingA);
  });

  it('same template across Buildings: task B resolves B even though task A sorts first', async (t) => {
    if (!ready(t)) return;
    // genTaskA has the EARLIER occurrence_at; a template-first lookup (the
    // pre-PART 02A defect) would have returned Building A for this execution.
    const ctx = await resolveMobileChecklistWorkContext(
      execBoundToB,
      workerUserId,
    );
    assert.equal(ctx.buildingId, buildingB, 'must resolve B, never A');
  });

  it('bound-to-B mutation is rejected (off-shift B) — no template-first grant', async (t) => {
    if (!ready(t)) return;
    // The worker is on shift at A, not B. genTaskA (Building A, template T)
    // would have granted this under the old template-first lookup; the
    // authoritative binding to B must reject because B is off-shift.
    const code = await errorCodeOf(
      executeMobileChecklistStart(execBoundToB, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('bound-to-A mutation succeeds when on shift (assigned worker)', async (t) => {
    if (!ready(t)) return;
    const row = await executeMobileChecklistStart(
      execBoundToA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.status, 'IN_PROGRESS');
  });

  it('an unbound/standalone execution never guesses a generated task', async (t) => {
    if (!ready(t)) return;
    const ctx = await resolveMobileChecklistWorkContext(execUnbound, workerUserId);
    assert.equal(ctx, null, 'unbound execution must not guess a task');
  });

  it('mobile mutation of an unbound execution FAILS CLOSED', async (t) => {
    if (!ready(t)) return;
    const code = await errorCodeOf(
      executeMobileChecklistStart(execUnbound, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('generic Web/admin standalone execution remains backward-compatible', async (t) => {
    if (!ready(t)) return;
    const created = await api()
      .post(`/api/v1/checklist-templates/${templateStandalone}/executions`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const executionId = created.body.data.id;
    const started = await api()
      .post(`/api/v1/checklist-executions/${executionId}/start`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'IN_PROGRESS');
  });

  it('a cross-Client generated-task binding cannot be forged', async (t) => {
    if (!ready(t)) return;
    // execCrossClient is a client A execution (accessible to the worker) but
    // its generated_task_id points to a client B task. The resolver must treat
    // it as not field work and the mobile mutation must fail closed.
    const ctx = await resolveMobileChecklistWorkContext(
      execCrossClient,
      workerUserId,
    );
    assert.equal(ctx, null, 'cross-Client binding must be rejected');
    const code = await errorCodeOf(
      executeMobileChecklistStart(execCrossClient, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('wrong/unassigned worker is rejected; the assigned worker is accepted', async (t) => {
    if (!ready(t)) return;
    // MOB-C04 PART 02B adds a UNIQUE partial index: at most ONE execution per
    // generated task. So each worker check uses its own fresh task.
    const taskForWorker = await createGeneratedTask(
      clientA,
      templateT,
      buildingA,
      '2026-08-06T01:00:00Z',
    );
    await assignTaskToProfile(taskForWorker, workerProfileId);
    const execAssigned = await createUnboundExecution(clientA, templateT);
    await bindExecution(execAssigned, taskForWorker);
    const ok = await errorCodeOf(
      executeMobileChecklistStart(execAssigned, workerUserId, ON_SHIFT),
    );
    assert.equal(ok, 'NO_ERROR');

    // A bound-to-A task assigned to the OTHER worker is not executable by the
    // first worker → rejected.
    const taskForOther = await createGeneratedTask(
      clientA,
      templateT,
      buildingA,
      '2026-08-06T02:00:00Z',
    );
    await assignTaskToProfile(taskForOther, otherWorkerProfileId);
    const execOther = await createUnboundExecution(clientA, templateT);
    await bindExecution(execOther, taskForOther);
    const rejected = await errorCodeOf(
      executeMobileChecklistStart(execOther, workerUserId, ON_SHIFT),
    );
    assert.equal(rejected, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('migrations add nullable generated_task_id + unique per-task index; down removes both', async (t) => {
    if (!ready(t)) return;
    const col = await q(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name='checklist_executions' AND column_name='generated_task_id'`,
    );
    assert.equal(col.rowCount, 1, 'generated_task_id column must exist');
    assert.equal(col.rows[0].is_nullable, 'YES');

    // The 0339 partial unique index is present.
    const idx = await q(
      `SELECT indexname FROM pg_indexes
        WHERE tablename='checklist_executions'
          AND indexname='checklist_executions_generated_task_unique'`,
    );
    assert.equal(idx.rowCount, 1, 'unique per-task index must exist');

    // Round-trip both migrations (0338 column + 0339 index): two downs remove
    // them (0339 first, then 0338), a single up re-applies both.
    await migrateDown(pool);
    const afterFirstDown = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='checklist_executions' AND column_name='generated_task_id'`,
    );
    assert.equal(
      afterFirstDown.rowCount,
      1,
      'first down removes 0339 index only; column (0338) remains',
    );
    await migrateDown(pool);
    const afterSecondDown = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='checklist_executions' AND column_name='generated_task_id'`,
    );
    assert.equal(afterSecondDown.rowCount, 0, 'down of 0338 removes the column');
    await migrateUp(pool);
    const afterUp = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='checklist_executions' AND column_name='generated_task_id'`,
    );
    assert.equal(afterUp.rowCount, 1, 'up() must re-add generated_task_id');
  });
});
