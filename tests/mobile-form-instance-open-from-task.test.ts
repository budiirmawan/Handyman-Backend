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
import { openFormInstanceForTask } from '../src/modules/mobile-form-instances';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C07 PART 02 — Authoritative task → form-instance open (get-or-create).
 *
 * Proves the smallest backend-authoritative flow that opens a bound DRAFT
 * Form Instance for an executable FORM_VERSION generated task.
 */

const DB_PORT = 55496;
const DATA_DIR = '/tmp/asentra-mob-c07-p02-pg';
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
let otherWorkerUserId = '';
let otherWorkerProfileId = '';
let noExecuteToken = '';

let clientA = '';
let clientB = '';
let buildingA = '';
let buildingB = '';
let teamMatch = '';
let teamOther = '';

let publishedVersionId = '';
let otherPublishedVersionId = '';
let draftVersionId = '';
let retiredVersionId = '';
let inactiveParentVersionId = '';
let clientBVersionId = '';
let formTemplateId = '';

let formTaskA = '';

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
  const password = 'FormOpenPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Form Open User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Form Open Role',
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
    fullName: 'Form Open Worker',
  });
  return profile.id;
}

async function seedFormVersion(options: {
  clientId: string;
  templateStatus?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  versionStatus?: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  versionNumber?: number;
}): Promise<{ templateId: string; versionId: string }> {
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
  return { templateId, versionId };
}

async function createGeneratedTask(
  clientId: string,
  buildingId: string,
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

async function assignToTeam(taskId: string, teamId: string): Promise<void> {
  await insertRow('task_assignments', {
    task_id: taskId,
    assignee_type: 'TEAM',
    workforce_profile_id: null,
    team_id: teamId,
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

async function countInstancesForTask(taskId: string): Promise<number> {
  const result = await q(
    'SELECT count(*)::int AS n FROM form_instances WHERE generated_task_id = $1',
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
  teamMatch = await insertRow('teams', {
    department_id: dept.id,
    code: `TEAM_${suffix()}`,
    name: 'Match Team',
    status: 'ACTIVE',
  });
  teamOther = await insertRow('teams', {
    department_id: dept.id,
    code: `TEAM_${suffix()}`,
    name: 'Other Team',
    status: 'ACTIVE',
  });

  const worker = await createUser('wform', [
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
  await q('UPDATE workforce_profiles SET team_id = $1 WHERE id = $2', [
    teamMatch,
    workerProfileId,
  ]);

  const other = await createUser('oform', [
    { code: 'form_instance.execute', name: 'Execute Form Instances' },
  ]);
  otherWorkerUserId = other.userId;
  await buildingAssignmentService.createAssignment(other.userId, {
    buildingId: buildingA,
  });
  otherWorkerProfileId = await buildProfile(
    other.userId,
    org.id,
    dept.id,
    position.id,
  );

  const noExecute = await createUser('nform', [
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
  await assignShiftToWorkforce({
    workforceProfileId: otherWorkerProfileId,
    shiftId: shiftA.id,
  });

  const published = await seedFormVersion({ clientId: clientA });
  formTemplateId = published.templateId;
  publishedVersionId = published.versionId;
  const otherPublished = await seedFormVersion({
    clientId: clientA,
    versionNumber: 1,
  });
  otherPublishedVersionId = otherPublished.versionId;
  draftVersionId = (await seedFormVersion({
    clientId: clientA,
    versionStatus: 'DRAFT',
  })).versionId;
  retiredVersionId = (await seedFormVersion({
    clientId: clientA,
    versionStatus: 'RETIRED',
  })).versionId;
  inactiveParentVersionId = (await seedFormVersion({
    clientId: clientA,
    templateStatus: 'INACTIVE',
  })).versionId;
  clientBVersionId = (await seedFormVersion({ clientId: clientB })).versionId;

  formTaskA = await createGeneratedTask(
    clientA,
    buildingA,
    'FORM_VERSION',
    publishedVersionId,
  );
  await assignToProfile(formTaskA, workerProfileId);
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

describe('MOB-C07 PART 02 — task → form-instance open flow', () => {
  it('assigned + current-shift worker creates a bound DRAFT instance', async (t) => {
    if (!ready(t)) return;
    const row = await openFormInstanceForTask(
      formTaskA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.started_at, null);
    assert.equal(row.generated_task_id, formTaskA);
    assert.equal(row.form_template_version_id, publishedVersionId);
    assert.equal(row.client_id, clientA);
  });

  it('persists the exact generated_task_id and form template version', async (t) => {
    if (!ready(t)) return;
    const stored = await q(
      `SELECT generated_task_id, form_template_version_id, client_id, status
         FROM form_instances WHERE generated_task_id = $1`,
      [formTaskA],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].generated_task_id, formTaskA);
    assert.equal(stored.rows[0].form_template_version_id, publishedVersionId);
    assert.equal(stored.rows[0].client_id, clientA);
    assert.equal(stored.rows[0].status, 'DRAFT');
  });

  it('a repeated request returns the SAME instance (idempotent get-or-create)', async (t) => {
    if (!ready(t)) return;
    const first = await openFormInstanceForTask(
      formTaskA,
      workerUserId,
      ON_SHIFT,
    );
    const second = await openFormInstanceForTask(
      formTaskA,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(second.id, first.id);
    assert.equal(await countInstancesForTask(formTaskA), 1);
  });

  it('concurrent get-or-create never duplicates (unique partial index backstop)', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    const results = await Promise.all([
      openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
    ]);
    const uniqueIds = new Set(results.map((r) => r.id));
    assert.equal(uniqueIds.size, 1, 'all concurrent calls return the same instance');
    assert.equal(await countInstancesForTask(taskId), 1);
  });

  it('a FORM_TEMPLATE task is rejected without creating an instance', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_TEMPLATE',
      formTemplateId,
    );
    await assignToProfile(taskId, workerProfileId);
    const message = await errorMessageOf(
      openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
    );
    assert.equal(message, 'Task is not a form-version task.');
    assert.equal(await countInstancesForTask(taskId), 0);
  });

  it('rejects DRAFT and RETIRED versions', async (t) => {
    if (!ready(t)) return;
    const draftTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      draftVersionId,
    );
    await assignToProfile(draftTask, workerProfileId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(draftTask, workerUserId, ON_SHIFT),
      ),
      'Only published template versions can create instances.',
    );

    const retiredTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      retiredVersionId,
    );
    await assignToProfile(retiredTask, workerProfileId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(retiredTask, workerUserId, ON_SHIFT),
      ),
      'Only published template versions can create instances.',
    );
  });

  it('rejects a published version whose parent template is INACTIVE', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      inactiveParentVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'Form template is not active.',
    );
  });

  it('rejects a task whose client_id does not match the parent template client', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      clientBVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'Task client does not match the form template client.',
    );
  });

  it('an inaccessible Building task is rejected', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingB,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    assert.equal(
      await errorCodeOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('off-shift worker is rejected', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    assert.equal(
      await errorCodeOf(
        openFormInstanceForTask(taskId, workerUserId, OFF_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('an unassigned task is rejected', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    assert.equal(
      await errorCodeOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('a different worker not assigned to the task is rejected', async (t) => {
    if (!ready(t)) return;
    assert.equal(
      await errorCodeOf(
        openFormInstanceForTask(formTaskA, otherWorkerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('TEAM assignment matching the caller team is allowed', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToTeam(taskId, teamMatch);
    const row = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.generated_task_id, taskId);
  });

  it('TEAM assignment that does not match the caller team is denied', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToTeam(taskId, teamOther);
    assert.equal(
      await errorCodeOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('COMPLETED and CANCELLED tasks are denied', async (t) => {
    if (!ready(t)) return;
    const completed = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
      'COMPLETED',
    );
    await assignToProfile(completed, workerProfileId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(completed, workerUserId, ON_SHIFT),
      ),
      'Task is already terminal.',
    );

    const cancelled = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
      'CANCELLED',
    );
    await assignToProfile(cancelled, workerProfileId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(cancelled, workerUserId, ON_SHIFT),
      ),
      'Task is already terminal.',
    );
  });

  it('missing form_instance.execute is 403', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .post(`/api/v1/mobile/tasks/${formTaskA}/form-instance`)
      .set('Authorization', `Bearer ${noExecuteToken}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('execute succeeds without form_template.manage; body ids cannot redirect', async (t) => {
    if (!ready(t)) return;
    const jakartaHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date()),
    );
    if (jakartaHour < 7 || jakartaHour >= 15) {
      t.skip('HTTP open uses wall-clock shift; fixture window is 07–15 Asia/Jakarta');
      return;
    }
    const response = await api()
      .post(`/api/v1/mobile/tasks/${formTaskA}/form-instance`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({
        clientId: clientB,
        buildingId: buildingB,
        generatedTaskId: randomUUID(),
        formTemplateVersionId: otherPublishedVersionId,
      });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.status, 'DRAFT');
    assert.equal(response.body.data.generatedTaskId, formTaskA);
    assert.equal(response.body.data.formTemplateVersionId, publishedVersionId);
    assert.ok(response.body.data.id);
  });

  it('an inconsistent bound row fails closed without auto-repair', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: otherPublishedVersionId,
      generated_task_id: taskId,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'Bound form instance is inconsistent with the task.',
    );
    const stored = await q(
      'SELECT form_template_version_id FROM form_instances WHERE generated_task_id = $1',
      [taskId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].form_template_version_id, otherPublishedVersionId);
  });
});
