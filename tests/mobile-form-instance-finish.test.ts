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
  finishMobileFormInstance,
  openFormInstanceForTask,
  saveMobileFormResponses,
  startMobileFormInstance,
} from '../src/modules/mobile-form-instances';
import {
  createFormInstance,
  finishFormInstance,
  saveFormResponses,
} from '../src/modules/form-instances';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C07 PART 04 — Mobile complete + cancel on already task-bound Form
 * Instances. Authority is re-checked on every mutation; lifecycle is PART 01A
 * `finishFormInstance`. Completing/cancelling the Form does not mutate the
 * generated task.
 */

const DB_PORT = 55498;
const DATA_DIR = '/tmp/asentra-mob-c07-p04-pg';
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
let noExecuteToken = '';

let clientA = '';
let clientB = '';
let buildingA = '';
let buildingB = '';

let publishedVersionId = '';
let requiredFieldId = '';
let otherPublishedVersionId = '';

const TZ = 'Asia/Jakarta';
const ON_SHIFT = new Date('2026-08-20T02:00:00Z');
const OFF_SHIFT = new Date('2026-08-20T09:00:00Z');

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
  const password = 'FormFinishPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Form Finish User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Form Finish Role',
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
    fullName: 'Form Finish Worker',
  });
  return profile.id;
}

async function seedFormVersion(options: {
  clientId: string;
  templateStatus?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  versionStatus?: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  versionNumber?: number;
  required?: boolean;
}): Promise<{ templateId: string; versionId: string; fieldId: string }> {
  const sourceId = await insertRow('source_forms', {
    client_id: options.clientId,
    code: `SRC_${suffix()}`,
    name: 'Source',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  const templateId = await insertRow('form_templates', {
    source_form_id: sourceId,
    client_id: options.clientId,
    code: `TPL_${suffix()}`,
    name: 'Form template',
    status: options.templateStatus ?? 'ACTIVE',
  });
  const versionStatus = options.versionStatus ?? 'PUBLISHED';
  const versionId = await insertRow('form_template_versions', {
    form_template_id: templateId,
    version_number: options.versionNumber ?? 1,
    status: versionStatus,
    published_at: versionStatus === 'PUBLISHED' ? '2026-08-01T00:00:00Z' : null,
  });
  const sectionId = await insertRow('form_template_version_sections', {
    version_id: versionId,
    section_id: id(),
    code: `SEC_${suffix()}`,
    title: 'Section',
    display_order: 0,
    status: 'ACTIVE',
  });
  const fieldId = await insertRow('form_template_version_fields', {
    version_section_id: sectionId,
    field_id: id(),
    code: `FLD_${suffix()}`,
    label: 'Notes',
    field_type: 'TEXT',
    required: options.required ?? true,
    display_order: 0,
    status: 'ACTIVE',
  });
  return { templateId, versionId, fieldId };
}

async function createGeneratedTask(
  clientId: string,
  buildingId: string | null,
  targetType: string,
  targetId: string,
  status = 'OPEN',
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${suffix()}`,
    name: 'Form schedule',
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
    status,
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

async function errorMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { message?: string }).message ?? 'NO_MESSAGE';
  }
  return 'NO_ERROR';
}

async function boundDraft(options?: {
  status?: string;
  assign?: boolean;
  versionId?: string;
}): Promise<{ taskId: string; instanceId: string }> {
  const taskId = await createGeneratedTask(
    clientA,
    buildingA,
    'FORM_VERSION',
    options?.versionId ?? publishedVersionId,
    options?.status ?? 'OPEN',
  );
  if (options?.assign !== false) {
    await assignToProfile(taskId, workerProfileId);
  }
  const row = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
  return { taskId, instanceId: row.id };
}

async function taskStatusOf(taskId: string): Promise<string> {
  const result = await q('SELECT status FROM generated_tasks WHERE id = $1', [
    taskId,
  ]);
  return result.rows[0].status as string;
}

async function countInstancesForTask(taskId: string): Promise<number> {
  const result = await q(
    'SELECT count(*)::int AS n FROM form_instances WHERE generated_task_id = $1',
    [taskId],
  );
  return result.rows[0].n as number;
}

async function saveRequired(
  instanceId: string,
  userId = workerUserId,
): Promise<void> {
  await saveMobileFormResponses(
    instanceId,
    userId,
    { fieldId: requiredFieldId, value: 'done' },
    ON_SHIFT,
  );
}

function wallClockInShiftWindow(): boolean {
  const jakartaHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  return jakartaHour >= 7 && jakartaHour < 15;
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
      user_building_assignments, organizations, departments, positions, teams,
      workforce_profiles, shifts, workforce_shift_assignments,
      schedule_definitions, generated_tasks, task_assignments,
      form_responses, form_instances,
      form_template_version_fields, form_template_version_sections,
      form_template_versions, form_fields, form_sections, form_templates,
      source_forms
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminUserId = admin.userId;
  adminToken = admin.token;

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

  const b = await clientService.createClient({
    code: `CB_${suffix()}`,
    name: 'Client B',
  });
  clientB = b.id;

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

  const worker = await createUser('wfin', [
    { code: 'form_instance.execute', name: 'Execute Form Instances' },
    { code: 'task.read', name: 'Read Tasks' },
    { code: 'work_order.read', name: 'Read Work Orders' },
  ]);
  workerUserId = worker.userId;
  workerToken = worker.token;
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingA,
  });
  workerProfileId = await buildProfile(worker.userId, org.id, dept.id, position.id);

  const noExecute = await createUser('nfin', [
    { code: 'checklist.manage', name: 'Manage Checklists' },
    { code: 'form_template.manage', name: 'Manage Form Templates' },
  ]);
  noExecuteToken = noExecute.token;
  await buildingAssignmentService.createAssignment(noExecute.userId, {
    buildingId: buildingA,
  });

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

  const published = await seedFormVersion({ clientId: clientA, required: true });
  publishedVersionId = published.versionId;
  requiredFieldId = published.fieldId;
  otherPublishedVersionId = (
    await seedFormVersion({ clientId: clientA, required: false })
  ).versionId;
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

describe('MOB-C07 PART 04 — mobile form instance complete + cancel', () => {
  it('completes a bound DRAFT instance with required responses without mutating the task', async (t) => {
    if (!ready(t)) return;
    const { taskId, instanceId } = await boundDraft();
    const before = await taskStatusOf(taskId);
    const statusBefore = await q(
      'SELECT status FROM form_instances WHERE id = $1',
      [instanceId],
    );
    assert.equal(statusBefore.rows[0].status, 'DRAFT');
    await saveRequired(instanceId);
    const row = await finishMobileFormInstance(
      instanceId,
      workerUserId,
      'complete',
      ON_SHIFT,
    );
    assert.equal(row.status, 'COMPLETED');
    assert.ok(row.completed_at);
    assert.equal(row.generated_task_id, taskId);
    assert.equal(await taskStatusOf(taskId), before);
    assert.equal(await taskStatusOf(taskId), 'OPEN');
  });

  it('rejects complete when a required response is missing', async (t) => {
    if (!ready(t)) return;
    const { instanceId, taskId } = await boundDraft();
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'complete', ON_SHIFT),
      ),
      'Required fields are missing.',
    );
    const stored = await q('SELECT status FROM form_instances WHERE id = $1', [
      instanceId,
    ]);
    assert.equal(stored.rows[0].status, 'DRAFT');
    assert.equal(await taskStatusOf(taskId), 'OPEN');
  });

  it('completes an IN_PROGRESS instance after start + required save', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    await startMobileFormInstance(instanceId, workerUserId, ON_SHIFT);
    await saveRequired(instanceId);
    const row = await finishMobileFormInstance(
      instanceId,
      workerUserId,
      'complete',
      ON_SHIFT,
    );
    assert.equal(row.status, 'COMPLETED');
    assert.ok(row.completed_at);
  });

  it('denies unbound instances on mobile complete/cancel', async (t) => {
    if (!ready(t)) return;
    const unboundId = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      status: 'DRAFT',
    });
    assert.equal(
      await errorCodeOf(
        finishMobileFormInstance(unboundId, workerUserId, 'complete', ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
    assert.equal(
      await errorCodeOf(
        finishMobileFormInstance(unboundId, workerUserId, 'cancel', ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('fails closed on a version mismatch without auto-repair', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    const instanceId = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: otherPublishedVersionId,
      generated_task_id: taskId,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'complete', ON_SHIFT),
      ),
      'Bound form instance is inconsistent with the task.',
    );
    const stored = await q(
      'SELECT form_template_version_id, status FROM form_instances WHERE id = $1',
      [instanceId],
    );
    assert.equal(stored.rows[0].form_template_version_id, otherPublishedVersionId);
    assert.equal(stored.rows[0].status, 'DRAFT');
  });

  it('denies complete/cancel when the pinned version is later RETIRED', async (t) => {
    if (!ready(t)) return;
    const seeded = await seedFormVersion({ clientId: clientA, required: false });
    const { instanceId } = await boundDraft({ versionId: seeded.versionId });
    await q(
      `UPDATE form_template_versions SET status = 'RETIRED' WHERE id = $1`,
      [seeded.versionId],
    );
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'complete', ON_SHIFT),
      ),
      'Only published template versions can create instances.',
    );
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'cancel', ON_SHIFT),
      ),
      'Only published template versions can create instances.',
    );
  });

  it('denies complete/cancel when the parent template becomes INACTIVE', async (t) => {
    if (!ready(t)) return;
    const seeded = await seedFormVersion({ clientId: clientA, required: false });
    const { instanceId } = await boundDraft({ versionId: seeded.versionId });
    await q(`UPDATE form_templates SET status = 'INACTIVE' WHERE id = $1`, [
      seeded.templateId,
    ]);
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'cancel', ON_SHIFT),
      ),
      'Form template is not active.',
    );
  });

  it('denies complete after the assignment is removed', async (t) => {
    if (!ready(t)) return;
    const { instanceId, taskId } = await boundDraft();
    await saveRequired(instanceId);
    await q(`UPDATE task_assignments SET status = 'INACTIVE' WHERE task_id = $1`, [
      taskId,
    ]);
    assert.equal(
      await errorCodeOf(
        finishMobileFormInstance(instanceId, workerUserId, 'complete', ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('denies complete when the current shift is no longer valid', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    await saveRequired(instanceId);
    assert.equal(
      await errorCodeOf(
        finishMobileFormInstance(instanceId, workerUserId, 'complete', OFF_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('denies complete when the generated task is already terminal', async (t) => {
    if (!ready(t)) return;
    const completedTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
      'COMPLETED',
    );
    await assignToProfile(completedTask, workerProfileId);
    const completedInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: completedTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(
          completedInstance,
          workerUserId,
          'complete',
          ON_SHIFT,
        ),
      ),
      'Task is already terminal.',
    );

    const cancelledTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
      'CANCELLED',
    );
    await assignToProfile(cancelledTask, workerProfileId);
    const cancelledInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: cancelledTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(
          cancelledInstance,
          workerUserId,
          'complete',
          ON_SHIFT,
        ),
      ),
      'Task is already terminal.',
    );
    const stillDraft = await q(
      'SELECT status FROM form_instances WHERE id = $1',
      [completedInstance],
    );
    assert.equal(stillDraft.rows[0].status, 'DRAFT');
  });

  it('cancels a bound non-terminal instance without mutating or replacing the task bind', async (t) => {
    if (!ready(t)) return;
    const { taskId, instanceId } = await boundDraft();
    const before = await taskStatusOf(taskId);
    const row = await finishMobileFormInstance(
      instanceId,
      workerUserId,
      'cancel',
      ON_SHIFT,
    );
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.completed_at, null);
    assert.equal(row.generated_task_id, taskId);
    assert.equal(await taskStatusOf(taskId), before);
    assert.equal(await countInstancesForTask(taskId), 1);
    const stored = await q(
      `SELECT id, generated_task_id, status, completed_at
         FROM form_instances WHERE generated_task_id = $1`,
      [taskId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].id, instanceId);
    assert.equal(stored.rows[0].generated_task_id, taskId);
    assert.equal(stored.rows[0].status, 'CANCELLED');
  });

  it('rejects a second cancel with the shared terminal guard', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    await finishMobileFormInstance(instanceId, workerUserId, 'cancel', ON_SHIFT);
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'cancel', ON_SHIFT),
      ),
      'Instance is already terminal.',
    );
  });

  it('denies cancel after assignment is removed or shift is invalid', async (t) => {
    if (!ready(t)) return;
    const removed = await boundDraft();
    await q(
      `UPDATE task_assignments SET status = 'INACTIVE' WHERE task_id = $1`,
      [removed.taskId],
    );
    assert.equal(
      await errorCodeOf(
        finishMobileFormInstance(
          removed.instanceId,
          workerUserId,
          'cancel',
          ON_SHIFT,
        ),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );

    const { instanceId } = await boundDraft();
    assert.equal(
      await errorCodeOf(
        finishMobileFormInstance(instanceId, workerUserId, 'cancel', OFF_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('denies cancel when the generated task is already terminal', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
      'COMPLETED',
    );
    await assignToProfile(taskId, workerProfileId);
    const instanceId = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: taskId,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        finishMobileFormInstance(instanceId, workerUserId, 'cancel', ON_SHIFT),
      ),
      'Task is already terminal.',
    );
    const stored = await q('SELECT status FROM form_instances WHERE id = $1', [
      instanceId,
    ]);
    assert.equal(stored.rows[0].status, 'DRAFT');
  });

  it('missing form_instance.execute is HTTP 403 on complete and cancel', async (t) => {
    if (!ready(t)) return;
    const deniedComplete = await api()
      .post(`/api/v1/mobile/form-instances/${randomUUID()}/complete`)
      .set('Authorization', `Bearer ${noExecuteToken}`);
    assert.equal(deniedComplete.status, 403);
    assert.equal(deniedComplete.body.error.code, 'PERMISSION_DENIED');
    const deniedCancel = await api()
      .post(`/api/v1/mobile/form-instances/${randomUUID()}/cancel`)
      .set('Authorization', `Bearer ${noExecuteToken}`);
    assert.equal(deniedCancel.status, 403);
    assert.equal(deniedCancel.body.error.code, 'PERMISSION_DENIED');
  });

  it('HTTP complete/cancel succeed without form_template.manage; body ids cannot redirect', async (t) => {
    if (!ready(t)) return;
    if (!wallClockInShiftWindow()) {
      t.skip('HTTP mutations use wall-clock shift; fixture window is 07–15 Asia/Jakarta');
      return;
    }
    const completeCase = await boundDraft();
    await saveRequired(completeCase.instanceId);
    const completed = await api()
      .post(`/api/v1/mobile/form-instances/${completeCase.instanceId}/complete`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({
        clientId: clientB,
        buildingId: buildingB,
        generatedTaskId: randomUUID(),
        formTemplateVersionId: otherPublishedVersionId,
      });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.status, 'COMPLETED');
    assert.equal(completed.body.data.generatedTaskId, completeCase.taskId);
    assert.ok(completed.body.data.completedAt);
    assert.equal(await taskStatusOf(completeCase.taskId), 'OPEN');

    const cancelCase = await boundDraft();
    const cancelled = await api()
      .post(`/api/v1/mobile/form-instances/${cancelCase.instanceId}/cancel`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ clientId: clientB, buildingId: buildingB });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.equal(cancelled.body.data.generatedTaskId, cancelCase.taskId);
    assert.equal(await taskStatusOf(cancelCase.taskId), 'OPEN');
  });

  it('PART 03 start/responses and PART 02 opener remain valid', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    const opened = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
    assert.equal(opened.status, 'DRAFT');
    const started = await startMobileFormInstance(
      opened.id,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(started.status, 'IN_PROGRESS');
    const saved = await saveMobileFormResponses(
      opened.id,
      workerUserId,
      { fieldId: requiredFieldId, value: 'p03' },
      ON_SHIFT,
    );
    assert.deepEqual(saved, {});
    const again = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
    assert.equal(again.id, opened.id);
    assert.equal(again.status, 'IN_PROGRESS');
  });

  it('generic Form Instance complete/cancel remain on form_template.manage', async (t) => {
    if (!ready(t)) return;
    const created = await createFormInstance(publishedVersionId, adminUserId);
    assert.equal(created.generated_task_id, null);
    await saveFormResponses(created.id, adminUserId, {
      fieldId: requiredFieldId,
      value: 'generic',
    });
    const completed = await finishFormInstance(created.id, adminUserId, 'complete');
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.completed_at);

    const other = await createFormInstance(publishedVersionId, adminUserId);
    const cancelled = await finishFormInstance(other.id, adminUserId, 'cancel');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.completed_at, null);

    const httpCreated = await api()
      .post(`/api/v1/form-template-versions/${publishedVersionId}/instances`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(httpCreated.status, 201, JSON.stringify(httpCreated.body));
    const workerDenied = await api()
      .post(`/api/v1/form-instances/${httpCreated.body.data.id}/complete`)
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(workerDenied.status, 403);
    assert.equal(workerDenied.body.error.code, 'PERMISSION_DENIED');
    const adminCancel = await api()
      .post(`/api/v1/form-instances/${httpCreated.body.data.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(adminCancel.status, 200, JSON.stringify(adminCancel.body));
    assert.equal(adminCancel.body.data.status, 'CANCELLED');
  });
});
