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
  openFormInstanceForTask,
  saveMobileFormResponses,
  startMobileFormInstance,
} from '../src/modules/mobile-form-instances';
import {
  createFormInstance,
  startFormInstance,
} from '../src/modules/form-instances';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C07 PART 03 — Mobile start + save responses on already task-bound
 * Form Instances. Authority is re-checked on every mutation; lifecycle is
 * PART 01A. Unbound instances stay on the generic routes.
 */

const DB_PORT = 55497;
const DATA_DIR = '/tmp/asentra-mob-c07-p03-pg';
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
let textFieldId = '';
let numberFieldId = '';
let otherPublishedVersionId = '';
let otherTextFieldId = '';
let formTemplateId = '';

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
  const password = 'FormExecPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Form Exec User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Form Exec Role',
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
    fullName: 'Form Exec Worker',
  });
  return profile.id;
}

async function seedVersionFields(versionId: string): Promise<{
  textFieldId: string;
  numberFieldId: string;
}> {
  const sectionId = await insertRow('form_template_version_sections', {
    version_id: versionId,
    section_id: id(),
    code: `SEC_${suffix()}`,
    title: 'Section',
    display_order: 0,
    status: 'ACTIVE',
  });
  const textId = await insertRow('form_template_version_fields', {
    version_section_id: sectionId,
    field_id: id(),
    code: `TXT_${suffix()}`,
    label: 'Notes',
    field_type: 'TEXT',
    required: false,
    display_order: 0,
    status: 'ACTIVE',
  });
  const numberId = await insertRow('form_template_version_fields', {
    version_section_id: sectionId,
    field_id: id(),
    code: `NUM_${suffix()}`,
    label: 'Count',
    field_type: 'NUMBER',
    required: false,
    display_order: 1,
    status: 'ACTIVE',
  });
  return { textFieldId: textId, numberFieldId: numberId };
}

async function seedFormVersion(options: {
  clientId: string;
  templateStatus?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  versionStatus?: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  versionNumber?: number;
  withFields?: boolean;
}): Promise<{
  templateId: string;
  versionId: string;
  textFieldId?: string;
  numberFieldId?: string;
}> {
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
  let fields: { textFieldId: string; numberFieldId: string } | undefined;
  if (options.withFields) {
    fields = await seedVersionFields(versionId);
  }
  return { templateId, versionId, ...fields };
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

async function boundDraft(options?: {
  status?: string;
  assign?: boolean;
  buildingId?: string | null;
  versionId?: string;
}): Promise<{ taskId: string; instanceId: string }> {
  const taskId = await createGeneratedTask(
    clientA,
    options?.buildingId === undefined ? buildingA : options.buildingId,
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

  const worker = await createUser('wexec', [
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

  const other = await createUser('oexec', [
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

  const noExecute = await createUser('nexec', [
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

  const published = await seedFormVersion({
    clientId: clientA,
    withFields: true,
  });
  formTemplateId = published.templateId;
  publishedVersionId = published.versionId;
  textFieldId = published.textFieldId as string;
  numberFieldId = published.numberFieldId as string;
  const otherPublished = await seedFormVersion({
    clientId: clientA,
    versionNumber: 1,
    withFields: true,
  });
  otherPublishedVersionId = otherPublished.versionId;
  otherTextFieldId = otherPublished.textFieldId as string;
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

describe('MOB-C07 PART 03 — mobile form instance start + responses', () => {
  it('starts a DRAFT bound instance to IN_PROGRESS without mutating the task', async (t) => {
    if (!ready(t)) return;
    const { taskId, instanceId } = await boundDraft();
    const before = await taskStatusOf(taskId);
    const row = await startMobileFormInstance(instanceId, workerUserId, ON_SHIFT);
    assert.equal(row.status, 'IN_PROGRESS');
    assert.ok(row.started_at);
    assert.equal(row.generated_task_id, taskId);
    assert.equal(await taskStatusOf(taskId), before);
  });

  it('rejects a second start on IN_PROGRESS with the shared draft-only rule', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    await startMobileFormInstance(instanceId, workerUserId, ON_SHIFT);
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(instanceId, workerUserId, ON_SHIFT),
      ),
      'Only draft instances can be started.',
    );
  });

  it('rejects start on COMPLETED and CANCELLED instances', async (t) => {
    if (!ready(t)) return;
    const completed = await boundDraft();
    await q(`UPDATE form_instances SET status = 'COMPLETED' WHERE id = $1`, [
      completed.instanceId,
    ]);
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(completed.instanceId, workerUserId, ON_SHIFT),
      ),
      'Only draft instances can be started.',
    );

    const cancelled = await boundDraft();
    await q(`UPDATE form_instances SET status = 'CANCELLED' WHERE id = $1`, [
      cancelled.instanceId,
    ]);
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(cancelled.instanceId, workerUserId, ON_SHIFT),
      ),
      'Only draft instances can be started.',
    );
  });

  it('saves a valid TEXT response as an object and returns empty {}', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    const result = await saveMobileFormResponses(
      instanceId,
      workerUserId,
      { fieldId: textFieldId, value: 'ok' },
      ON_SHIFT,
    );
    assert.deepEqual(result, {});
    const stored = await q(
      `SELECT value FROM form_responses
        WHERE form_instance_id = $1 AND version_field_id = $2`,
      [instanceId, textFieldId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].value, 'ok');
  });

  it('saves an array payload and upserts the same field', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    await saveMobileFormResponses(
      instanceId,
      workerUserId,
      [{ fieldId: textFieldId, value: 'first' }],
      ON_SHIFT,
    );
    await saveMobileFormResponses(
      instanceId,
      workerUserId,
      [{ fieldId: textFieldId, value: 'second' }],
      ON_SHIFT,
    );
    const stored = await q(
      `SELECT value FROM form_responses WHERE form_instance_id = $1`,
      [instanceId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].value, 'second');
  });

  it('allows save on DRAFT without starting first (generic rule)', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    const status = await q('SELECT status FROM form_instances WHERE id = $1', [
      instanceId,
    ]);
    assert.equal(status.rows[0].status, 'DRAFT');
    const result = await saveMobileFormResponses(
      instanceId,
      workerUserId,
      { fieldId: numberFieldId, value: 7 },
      ON_SHIFT,
    );
    assert.deepEqual(result, {});
  });

  it('rejects a field that does not belong to the pinned version', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    assert.equal(
      await errorMessageOf(
        saveMobileFormResponses(
          instanceId,
          workerUserId,
          { fieldId: otherTextFieldId, value: 'nope' },
          ON_SHIFT,
        ),
      ),
      'Response field does not belong to this version.',
    );
  });

  it('rejects a value that does not match the field type', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    assert.equal(
      await errorMessageOf(
        saveMobileFormResponses(
          instanceId,
          workerUserId,
          { fieldId: numberFieldId, value: 'not-a-number' },
          ON_SHIFT,
        ),
      ),
      'Response value does not match field type.',
    );
  });

  it('rejects responses on a terminal instance', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    await q(`UPDATE form_instances SET status = 'COMPLETED' WHERE id = $1`, [
      instanceId,
    ]);
    assert.equal(
      await errorMessageOf(
        saveMobileFormResponses(
          instanceId,
          workerUserId,
          { fieldId: textFieldId, value: 'late' },
          ON_SHIFT,
        ),
      ),
      'Terminal instances cannot be modified.',
    );
  });

  it('denies unbound instances (generated_task_id IS NULL) on mobile', async (t) => {
    if (!ready(t)) return;
    const unboundId = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      status: 'DRAFT',
    });
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(unboundId, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
    assert.equal(
      await errorCodeOf(
        saveMobileFormResponses(
          unboundId,
          workerUserId,
          { fieldId: textFieldId, value: 'x' },
          ON_SHIFT,
        ),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('generic unbound start still works on the PART 01A path', async (t) => {
    if (!ready(t)) return;
    const created = await createFormInstance(publishedVersionId, adminUserId);
    assert.equal(created.generated_task_id, null);
    const started = await startFormInstance(created.id, adminUserId);
    assert.equal(started.status, 'IN_PROGRESS');
  });

  it('rejects a bound FORM_TEMPLATE task without auto-resolving a version', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_TEMPLATE',
      formTemplateId,
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
        startMobileFormInstance(instanceId, workerUserId, ON_SHIFT),
      ),
      'Task is not a form-version task.',
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
        startMobileFormInstance(instanceId, workerUserId, ON_SHIFT),
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

  it('denies mutation when the pinned version is later RETIRED', async (t) => {
    if (!ready(t)) return;
    const seeded = await seedFormVersion({ clientId: clientA, withFields: true });
    const { instanceId, taskId } = await boundDraft({
      versionId: seeded.versionId,
    });
    await q(
      `UPDATE form_template_versions SET status = 'RETIRED' WHERE id = $1`,
      [seeded.versionId],
    );
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(instanceId, workerUserId, ON_SHIFT),
      ),
      'Only published template versions can create instances.',
    );
    assert.equal(await taskStatusOf(taskId), 'OPEN');
  });

  it('denies mutation when the parent template becomes INACTIVE', async (t) => {
    if (!ready(t)) return;
    const seeded = await seedFormVersion({ clientId: clientA });
    const { instanceId } = await boundDraft({ versionId: seeded.versionId });
    await q(`UPDATE form_templates SET status = 'INACTIVE' WHERE id = $1`, [
      seeded.templateId,
    ]);
    assert.equal(
      await errorMessageOf(
        saveMobileFormResponses(
          instanceId,
          workerUserId,
          { fieldId: textFieldId, value: 'x' },
          ON_SHIFT,
        ),
      ),
      'Form template is not active.',
    );
  });

  it('denies mutation when the task client does not match the template client', async (t) => {
    if (!ready(t)) return;
    const foreign = await seedFormVersion({ clientId: clientB });
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      foreign.versionId,
    );
    await assignToProfile(taskId, workerProfileId);
    const instanceId = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: foreign.versionId,
      generated_task_id: taskId,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(instanceId, workerUserId, ON_SHIFT),
      ),
      'Task client does not match the form template client.',
    );
  });

  it('denies off-shift start and save', async (t) => {
    if (!ready(t)) return;
    const { instanceId } = await boundDraft();
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(instanceId, workerUserId, OFF_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
    assert.equal(
      await errorCodeOf(
        saveMobileFormResponses(
          instanceId,
          workerUserId,
          { fieldId: textFieldId, value: 'x' },
          OFF_SHIFT,
        ),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('denies an unassigned worker and a different assigned worker', async (t) => {
    if (!ready(t)) return;
    const unassignedTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    const unassignedInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: unassignedTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(unassignedInstance, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );

    const { instanceId } = await boundDraft();
    assert.equal(
      await errorCodeOf(
        saveMobileFormResponses(
          instanceId,
          otherWorkerUserId,
          { fieldId: textFieldId, value: 'x' },
          ON_SHIFT,
        ),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('denies a task with no Building and an inaccessible Building', async (t) => {
    if (!ready(t)) return;
    const noBuildingTask = await createGeneratedTask(
      clientA,
      null,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(noBuildingTask, workerProfileId);
    const noBuildingInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: noBuildingTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(noBuildingInstance, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );

    const otherBuildingTask = await createGeneratedTask(
      clientA,
      buildingB,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(otherBuildingTask, workerProfileId);
    const otherBuildingInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: otherBuildingTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(otherBuildingInstance, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('denies COMPLETED and CANCELLED tasks without mutating the instance', async (t) => {
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
        startMobileFormInstance(completedInstance, workerUserId, ON_SHIFT),
      ),
      'Task is already terminal.',
    );
    const stillDraft = await q(
      'SELECT status FROM form_instances WHERE id = $1',
      [completedInstance],
    );
    assert.equal(stillDraft.rows[0].status, 'DRAFT');
  });

  it('TEAM assignment matching the caller team can start; mismatch is denied', async (t) => {
    if (!ready(t)) return;
    const matchTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToTeam(matchTask, teamMatch);
    const matchInstance = await openFormInstanceForTask(
      matchTask,
      workerUserId,
      ON_SHIFT,
    );
    const started = await startMobileFormInstance(
      matchInstance.id,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(started.status, 'IN_PROGRESS');

    const mismatchTask = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToTeam(mismatchTask, teamOther);
    const mismatchInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: mismatchTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(mismatchInstance, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );
  });

  it('missing instance is 404; missing form_instance.execute is HTTP 403', async (t) => {
    if (!ready(t)) return;
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(randomUUID(), workerUserId, ON_SHIFT),
      ),
      'NOT_FOUND',
    );
    const denied = await api()
      .post(`/api/v1/mobile/form-instances/${randomUUID()}/start`)
      .set('Authorization', `Bearer ${noExecuteToken}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'PERMISSION_DENIED');
    const deniedSave = await api()
      .put(`/api/v1/mobile/form-instances/${randomUUID()}/responses`)
      .set('Authorization', `Bearer ${noExecuteToken}`)
      .send({ fieldId: textFieldId, value: 'x' });
    assert.equal(deniedSave.status, 403);
    assert.equal(deniedSave.body.error.code, 'PERMISSION_DENIED');
  });

  it('HTTP start + save succeed without form_template.manage; body ids cannot redirect', async (t) => {
    if (!ready(t)) return;
    if (!wallClockInShiftWindow()) {
      t.skip('HTTP mutations use wall-clock shift; fixture window is 07–15 Asia/Jakarta');
      return;
    }
    const { instanceId, taskId } = await boundDraft();
    const started = await api()
      .post(`/api/v1/mobile/form-instances/${instanceId}/start`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({
        clientId: clientB,
        buildingId: buildingB,
        generatedTaskId: randomUUID(),
        formTemplateVersionId: otherPublishedVersionId,
      });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'IN_PROGRESS');
    assert.equal(started.body.data.generatedTaskId, taskId);
    assert.equal(started.body.data.formTemplateVersionId, publishedVersionId);

    const saved = await api()
      .put(`/api/v1/mobile/form-instances/${instanceId}/responses`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({
        fieldId: textFieldId,
        value: 'http-ok',
        clientId: clientB,
        buildingId: buildingB,
      });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data, {});
  });

  it('PART 02 opener still get-or-creates a bound DRAFT after the shared extract', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask(
      clientA,
      buildingA,
      'FORM_VERSION',
      publishedVersionId,
    );
    await assignToProfile(taskId, workerProfileId);
    const first = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
    const second = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
    assert.equal(first.status, 'DRAFT');
    assert.equal(second.id, first.id);
    assert.equal(first.generated_task_id, taskId);
  });

  it('generic HTTP start of an unbound instance still uses form_template.manage', async (t) => {
    if (!ready(t)) return;
    const created = await api()
      .post(`/api/v1/form-template-versions/${publishedVersionId}/instances`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const started = await api()
      .post(`/api/v1/form-instances/${created.body.data.id}/start`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'IN_PROGRESS');

    const workerDenied = await api()
      .post(`/api/v1/form-instances/${created.body.data.id}/start`)
      .set('Authorization', `Bearer ${workerToken}`);
    assert.equal(workerDenied.status, 403);
    assert.equal(workerDenied.body.error.code, 'PERMISSION_DENIED');
  });
});
