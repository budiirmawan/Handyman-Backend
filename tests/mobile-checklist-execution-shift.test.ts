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
  assertMobileChecklistExecutionCurrentShift,
  executeMobileChecklistFinish,
  executeMobileChecklistResponses,
  executeMobileChecklistStart,
} from '../src/modules/mobile-checklist';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C04 PART 02 — Online mobile checklist execution lock.
 *
 * Proves the authoritative current-shift Building authority gate on the mobile
 * online checklist command surface:
 *   1. on-shift + authorized mutation proceeds (start / responses / complete),
 *   2. accessible Building but off-shift → rejected,
 *   3. no current shift → rejected,
 *   4. inaccessible (cross-client) execution → rejected (no existence leak),
 *   5. wrong/unassigned work → rejected by the existing `checklist.manage`
 *      authority,
 *   6. client-provided building/shift parameters cannot bypass authority,
 *   7. read behavior is backward-compatible (off-shift stays readable),
 *   8. lifecycle/state validation still runs after the shift gate.
 *
 * `now` is injected only for deterministic shift windows; the HTTP-level checks
 * are deliberately clock-independent (permission, scope, building-less shift
 * rejection, read compatibility).
 */

const DB_PORT = 55473;
const DATA_DIR = '/tmp/asentra-mob-c04-p2-pg';
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

let workerUserId = '';
let workerToken = '';
let workerProfileId = '';
let readerUserId = '';
let readerToken = '';
let adminUserId = '';

let clientA = '';
let buildingA = ''; // accessible + roster (worker on shift here)
let buildingC = ''; // accessible but NO roster (never on shift)
let clientB = '';
let buildingB = ''; // cross-client / inaccessible

let templateA = '';
let templateC = '';
let templateNoTask = '';
let templateB = '';
let itemACheck = '';
let itemANumber = '';
let itemCheckAny = '';

let execOnShiftA = ''; // building A (start + lifecycle)
let execOnShiftB = ''; // building A (full lifecycle complete)
let execNoCurrentShift = ''; // building A, evaluated off-window
let execOffShiftC = ''; // building C (accessible, never on shift)
let execNoTask = ''; // client A, no task/building binding
let execCross = ''; // client B (inaccessible)

const TZ = 'Asia/Jakarta';
// Deterministic instants (Asia/Jakarta = UTC+7):
const ON_SHIFT = new Date('2026-08-20T02:00:00Z'); // 09:00 Jakarta, in 07:00–15:00
const OFF_SHIFT = new Date('2026-08-20T09:00:00Z'); // 16:00 Jakarta, outside window

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

async function createUserWithPermissions(
  codes: { code: string; name: string }[],
  emailPrefix: string,
): Promise<{ token: string; userId: string }> {
  const password = 'ShiftPass123';
  const user = await userService.createUser({
    email: `${emailPrefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Shift Worker',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${emailPrefix.toUpperCase()}_${suffix()}`,
    name: 'Shift Role',
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

/** Creates a checklist template (clientA style) and returns template + item ids. */
async function createTemplateWithItems(clientId: string): Promise<{
  templateId: string;
  itemCheck: string;
  itemNumber: string;
}> {
  const templateId = await insertRow('checklist_templates', {
    client_id: clientId,
    code: `TPL_${suffix()}`,
    name: 'Shift Checklist',
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

/** Creates an execution and (optionally) binds it to a Building via a task. */
async function createExecution(
  clientId: string,
  templateId: string,
  buildingId: string | null,
): Promise<string> {
  const executionId = await insertRow('checklist_executions', {
    client_id: clientId,
    checklist_template_id: templateId,
    status: 'DRAFT',
  });
  if (buildingId) {
    const scheduleId = await insertRow('schedule_definitions', {
      client_id: clientId,
      code: `SD_${suffix()}`,
      name: 'Checklist schedule',
      target_type: 'CHECKLIST_TEMPLATE',
      target_id: templateId,
      building_id: buildingId,
      start_at: '2026-08-01T00:00:00Z',
      timezone: TZ,
      status: 'ACTIVE',
    });
    const taskId = await insertRow('generated_tasks', {
      client_id: clientId,
      schedule_definition_id: scheduleId,
      occurrence_at: '2026-08-05T01:00:00Z',
      target_type: 'CHECKLIST_TEMPLATE',
      target_id: templateId,
      building_id: buildingId,
      status: 'OPEN',
    });
    // MOB-C04 PART 02A: bind the execution authoritatively to the generated
    // task and assign it to the worker (a field checklist execution).
    await q(
      'UPDATE checklist_executions SET generated_task_id = $1 WHERE id = $2',
      [taskId, executionId],
    );
    await insertRow('task_assignments', {
      task_id: taskId,
      assignee_type: 'WORKFORCE',
      workforce_profile_id: workerProfileId,
      team_id: null,
      assigned_by_user_id: adminUserId,
      status: 'ACTIVE',
    });
  }
  return executionId;
}

/** Returns the error code thrown by an async mobile execution call. */
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
      workforce_profiles, shifts, workforce_shift_assignments,
      schedule_definitions, generated_tasks, checklist_templates,
      checklist_items, checklist_item_responses, checklist_executions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;

  // Client A: building A (roster) + building C (accessible, no roster).
  const a = await clientService.createClient({
    code: `CA_${suffix()}`,
    name: 'Shift Client A',
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
  const bC = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BC_${suffix()}`,
    name: 'Building C',
    timezone: TZ,
  });
  buildingC = bC.id;

  // Client B: inaccessible to the worker.
  const b = await clientService.createClient({
    code: `CB_${suffix()}`,
    name: 'Shift Client B',
  });
  clientB = b.id;
  const propB = await propertyService.createProperty({
    clientId: clientB,
    code: `PB_${suffix()}`,
    name: 'Prop B',
  });
  const bB = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BB_${suffix()}`,
    name: 'Building B',
    timezone: TZ,
  });
  buildingB = bB.id;

  // Org chain under client A for the worker profile.
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

  // Worker: checklist.read + checklist.manage + task/work_order read.
  const worker = await createUserWithPermissions(
    [
      { code: 'task.read', name: 'Read Tasks' },
      { code: 'work_order.read', name: 'Read Work Orders' },
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'checklist.manage', name: 'Manage Checklists' },
    ],
    'worker',
  );
  workerToken = worker.token;
  workerUserId = worker.userId;
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingA,
  });
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingC,
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: position.id,
    userId: workerUserId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Shift Worker',
  });
  workerProfileId = profile.id;

  // Roster: morning shift at building A (Asia/Jakarta 07:00–15:00).
  const shiftA = await shiftService.createShift({
    clientId: clientA,
    buildingId: buildingA,
    code: `S_${suffix()}`,
    name: 'Morning shift',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  await assignShiftToWorkforce({
    workforceProfileId: workerProfileId,
    shiftId: shiftA.id,
  });

  // Reader: checklist.read only (no manage) for the authority-denial test.
  const reader = await createUserWithPermissions(
    [
      { code: 'checklist.read', name: 'Read Checklists' },
      { code: 'task.read', name: 'Read Tasks' },
    ],
    'reader',
  );
  readerToken = reader.token;
  readerUserId = reader.userId;
  await buildingAssignmentService.createAssignment(readerUserId, {
    buildingId: buildingA,
  });

  // Client A templates + executions.
  const tA = await createTemplateWithItems(clientA);
  templateA = tA.templateId;
  itemACheck = tA.itemCheck;
  itemANumber = tA.itemNumber;
  execOnShiftA = await createExecution(clientA, templateA, buildingA);
  execOnShiftB = await createExecution(clientA, templateA, buildingA);
  execNoCurrentShift = await createExecution(clientA, templateA, buildingA);

  const tC = await createTemplateWithItems(clientA);
  templateC = tC.templateId;
  itemCheckAny = tC.itemCheck;
  execOffShiftC = await createExecution(clientA, templateC, buildingC);

  const tN = await createTemplateWithItems(clientA);
  templateNoTask = tN.templateId;
  execNoTask = await createExecution(clientA, templateNoTask, null);

  // Client B (cross-client) execution.
  const tB = await createTemplateWithItems(clientB);
  templateB = tB.templateId;
  execCross = await createExecution(clientB, templateB, buildingB);
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

describe('MOB-C04 PART 02 — mobile online checklist execution lock', () => {
  it('on-shift authorized: start proceeds (DRAFT → IN_PROGRESS)', async (t) => {
    if (!ready(t)) return;
    const row = await executeMobileChecklistStart(
      execOnShiftA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.status, 'IN_PROGRESS');
    assert.ok(row.started_at);
  });

  it('on-shift authorized: responses + complete succeed through the shared service', async (t) => {
    if (!ready(t)) return;
    await executeMobileChecklistResponses(
      execOnShiftB,
      workerUserId,
      [
        { itemId: itemACheck, value: true },
        { itemId: itemANumber, value: 22.5 },
      ],
      ON_SHIFT,
    );
    const row = await executeMobileChecklistFinish(
      execOnShiftB,
      workerUserId,
      'complete',
      ON_SHIFT,
    );
    assert.equal(row.status, 'COMPLETED');
  });

  it('accessible Building but off-shift → rejected (NOT_IN_CURRENT_SHIFT)', async (t) => {
    if (!ready(t)) return;
    // execOffShiftC is bound to building C, which is accessible to the worker
    // but has no roster → never on shift there. Mutation must be rejected.
    const code = await errorCodeOf(
      executeMobileChecklistStart(execOffShiftC, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('no current shift (on-shift building but outside window) → rejected', async (t) => {
    if (!ready(t)) return;
    // execNoCurrentShift is bound to building A where the worker IS rostered,
    // but OFF_SHIFT (16:00 Jakarta) is outside the 07:00–15:00 window → not on
    // shift at this instant → rejected.
    const code = await errorCodeOf(
      executeMobileChecklistStart(execNoCurrentShift, workerUserId, OFF_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('no building binding (not field work) → rejected even while on shift', async (t) => {
    if (!ready(t)) return;
    const code = await errorCodeOf(
      executeMobileChecklistStart(execNoTask, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT');
  });

  it('inaccessible (cross-client) execution → rejected with BUILDING_ACCESS_DENIED', async (t) => {
    if (!ready(t)) return;
    const code = await errorCodeOf(
      executeMobileChecklistStart(execCross, workerUserId, ON_SHIFT),
    );
    assert.equal(code, 'BUILDING_ACCESS_DENIED');
  });

  it('wrong/unassigned work: a user without checklist.manage cannot execute (HTTP 403)', async (t) => {
    if (!ready(t)) return;
    // The route's `checklist.manage` guard (existing authority) rejects before
    // any mutation — clock-independent.
    const response = await api()
      .post(`/api/v1/mobile/checklist-executions/${execCross}/start`)
      .set('Authorization', `Bearer ${readerToken}`);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('client-provided building/shift parameters cannot bypass the shift gate (HTTP)', async (t) => {
    if (!ready(t)) return;
    // execOffShiftC is bound to building C; the client passes buildingId/shift
    // params but the backend ignores them → still NOT_IN_CURRENT_SHIFT.
    const offShift = await api()
      .post(
        `/api/v1/mobile/checklist-executions/${execOffShiftC}/start?shift=current&buildingId=${buildingA}`,
      )
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(offShift.status, 403, JSON.stringify(offShift.body));
    assert.equal(
      offShift.body.error.code,
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );

    // Inaccessible cross-client execution cannot be unlocked by any client param.
    const cross = await api()
      .post(
        `/api/v1/mobile/checklist-executions/${execCross}/start?buildingId=${buildingA}&shiftId=whatever`,
      )
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(cross.status, 403, JSON.stringify(cross.body));
    assert.equal(cross.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('read behavior is backward-compatible: off-shift/accessible execution stays readable', async (t) => {
    if (!ready(t)) return;
    // GET is client-scope only (no shift gate) — building C execution is
    // readable by the worker even though its mutation is locked.
    const response = await api()
      .get(`/api/v1/mobile/checklist-executions/${execOffShiftC}`)
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.status, 'DRAFT');
  });

  it('lifecycle/state validation still runs after the shift gate (on-shift terminal + required)', async (t) => {
    if (!ready(t)) return;
    // execOnShiftA was started above → a second START is rejected by the
    // lifecycle rule (gate passes first because the worker IS on shift at A).
    const doubleStart = await errorCodeOf(
      executeMobileChecklistStart(execOnShiftA, workerUserId, ON_SHIFT),
    );
    assert.equal(doubleStart, 'BAD_REQUEST');

    // A fresh on-shift execution completed with missing required items is
    // rejected by the completion rule.
    const execRequired = await createExecution(clientA, templateA, buildingA);
    const missing = await errorCodeOf(
      executeMobileChecklistFinish(
        execRequired,
        workerUserId,
        'complete',
        ON_SHIFT,
      ),
    );
    assert.equal(missing, 'BAD_REQUEST');
  });
});
