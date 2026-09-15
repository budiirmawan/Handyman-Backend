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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C07 PART 06 — Final cross-surface Form execution contract.
 *
 * One happy-path lifecycle (open → start → responses → complete → evidence
 * → review) plus permission / authority negatives. No new runtime behavior.
 */

const DB_PORT = 55500;
const DATA_DIR = '/tmp/asentra-mob-c07-p06-pg';
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
let evidenceToken = '';
let evidenceReadToken = '';
let reviewToken = '';

let clientA = '';
let buildingA = '';
let buildingACode = '';
let buildingAName = '';
let formTemplateId = '';
let publishedVersionId = '';
let requiredFieldId = '';
let formTaskId = '';

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
  const password = 'FormContractPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Form Contract User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Form Contract Role',
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

async function seedPublishedVersion(): Promise<{
  templateId: string;
  versionId: string;
  fieldId: string;
}> {
  const sourceId = await insertRow('source_forms', {
    client_id: clientA,
    code: `SRC_${suffix()}`,
    name: 'Source',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  const templateId = await insertRow('form_templates', {
    source_form_id: sourceId,
    client_id: clientA,
    code: `TPL_${suffix()}`,
    name: 'Form template',
    status: 'ACTIVE',
  });
  const versionId = await insertRow('form_template_versions', {
    form_template_id: templateId,
    version_number: 1,
    status: 'PUBLISHED',
    published_at: '2026-08-01T00:00:00Z',
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
    required: true,
    display_order: 0,
    status: 'ACTIVE',
  });
  return { templateId, versionId, fieldId };
}

async function createGeneratedTask(
  targetType: string,
  targetId: string,
  status = 'OPEN',
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SD_${suffix()}`,
    name: 'Form schedule',
    target_type: targetType,
    target_id: targetId,
    building_id: buildingA,
    start_at: '2026-08-01T00:00:00Z',
    timezone: TZ,
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-05T01:00:00Z',
    target_type: targetType,
    target_id: targetId,
    building_id: buildingA,
    status,
  });
}

async function assignToWorker(taskId: string): Promise<void> {
  await insertRow('task_assignments', {
    task_id: taskId,
    assignee_type: 'WORKFORCE',
    workforce_profile_id: workerProfileId,
    team_id: null,
    assigned_by_user_id: adminUserId,
    status: 'ACTIVE',
  });
}

async function errorMessageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { message?: string }).message ?? 'NO_MESSAGE';
  }
  return 'NO_ERROR';
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
}

async function taskStatusOf(taskId: string): Promise<string> {
  const result = await q('SELECT status FROM generated_tasks WHERE id = $1', [
    taskId,
  ]);
  return result.rows[0].status as string;
}

function evidenceBody(executionId: string) {
  return {
    evidenceType: 'PHOTO',
    executionType: 'FORM_INSTANCE',
    executionId,
    fileReference: `evidence/${randomUUID()}`,
    originalFileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1024,
  };
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
      source_forms, evidence_submissions, reviews
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
  buildingACode = bA.code;
  buildingAName = bA.name;
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

  const worker = await createUser('wcon', [
    { code: 'form_instance.execute', name: 'Execute Form Instances' },
    { code: 'task.read', name: 'Read Tasks' },
    { code: 'work_order.read', name: 'Read Work Orders' },
  ]);
  workerUserId = worker.userId;
  workerToken = worker.token;
  await buildingAssignmentService.createAssignment(workerUserId, {
    buildingId: buildingA,
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: org.id,
    departmentId: dept.id,
    positionId: position.id,
    userId: workerUserId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Form Contract Worker',
  });
  workerProfileId = profile.id;

  const evidence = await createUser('econ', [
    { code: 'evidence.manage', name: 'Manage Evidence' },
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  evidenceToken = evidence.token;
  await buildingAssignmentService.createAssignment(evidence.userId, {
    buildingId: buildingA,
  });
  const evidenceRead = await createUser('eread', [
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  evidenceReadToken = evidenceRead.token;
  await buildingAssignmentService.createAssignment(evidenceRead.userId, {
    buildingId: buildingA,
  });

  const review = await createUser('rcon', [
    { code: 'review.manage', name: 'Manage Reviews' },
    { code: 'review.read', name: 'Read Reviews' },
  ]);
  reviewToken = review.token;
  await buildingAssignmentService.createAssignment(review.userId, {
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

  const published = await seedPublishedVersion();
  formTemplateId = published.templateId;
  publishedVersionId = published.versionId;
  requiredFieldId = published.fieldId;

  formTaskId = await createGeneratedTask('FORM_VERSION', publishedVersionId);
  await assignToWorker(formTaskId);
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

describe('MOB-C07 PART 06 — final cross-surface Form contract', () => {
  it('runs open → start → responses → evidence → complete → review without mutating the task', async (t) => {
    if (!ready(t)) return;
    const opened = await openFormInstanceForTask(
      formTaskId,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(opened.status, 'DRAFT');
    assert.equal(opened.generated_task_id, formTaskId);
    assert.equal(opened.form_template_version_id, publishedVersionId);
    assert.equal(opened.client_id, clientA);

    const stored = await q(
      `SELECT generated_task_id, form_template_version_id, status
         FROM form_instances WHERE id = $1`,
      [opened.id],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].generated_task_id, formTaskId);

    const started = await startMobileFormInstance(
      opened.id,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(started.status, 'IN_PROGRESS');
    await saveMobileFormResponses(
      opened.id,
      workerUserId,
      { fieldId: requiredFieldId, value: 'done' },
      ON_SHIFT,
    );

    const evidence = await api()
      .post('/api/v1/evidence')
      .set('Authorization', `Bearer ${evidenceToken}`)
      .send(evidenceBody(opened.id));
    assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
    assert.equal(evidence.body.data.executionType, 'FORM_INSTANCE');
    assert.equal(evidence.body.data.executionId, opened.id);

    const read = await api()
      .get(`/api/v1/mobile/evidence/${evidence.body.data.id}`)
      .set('Authorization', `Bearer ${evidenceReadToken}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.target.executionId, opened.id);
    assert.equal(read.body.data.target.form.id, formTemplateId);
    assert.equal(read.body.data.target.task.taskId, formTaskId);
    assert.deepEqual(read.body.data.building, {
      id: buildingA,
      code: buildingACode,
      name: buildingAName,
    });

    const completed = await finishMobileFormInstance(
      opened.id,
      workerUserId,
      'complete',
      ON_SHIFT,
    );
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.completed_at);
    assert.equal(await taskStatusOf(formTaskId), 'OPEN');

    const review = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${reviewToken}`)
      .send({
        targetType: 'FORM_INSTANCE',
        targetId: opened.id,
        notes: 'verified',
      });
    assert.equal(review.status, 201, JSON.stringify(review.body));
    const decided = await api()
      .post(`/api/v1/reviews/${review.body.data.id}/decision`)
      .set('Authorization', `Bearer ${reviewToken}`)
      .send({ decision: 'APPROVED' });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    const verification = await api()
      .get(`/api/v1/mobile/verification/FORM_INSTANCE/${opened.id}`)
      .set('Authorization', `Bearer ${reviewToken}`);
    assert.equal(verification.status, 200, JSON.stringify(verification.body));
    assert.equal(verification.body.data.buildingId, buildingA);
    assert.equal(verification.body.data.resource.form.id, formTemplateId);
    assert.equal(await taskStatusOf(formTaskId), 'OPEN');
  });

  it('FORM_TEMPLATE mobile open fails closed', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask('FORM_TEMPLATE', formTemplateId);
    await assignToWorker(taskId);
    assert.equal(
      await errorMessageOf(
        openFormInstanceForTask(taskId, workerUserId, ON_SHIFT),
      ),
      'Task is not a form-version task.',
    );
  });

  it('unbound generic instances cannot use mobile mutations', async (t) => {
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
  });

  it('form_instance.execute does not grant evidence or review; those do not grant Form execution', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask('FORM_VERSION', publishedVersionId);
    await assignToWorker(taskId);
    const opened = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);

    const noEvidence = await api()
      .post('/api/v1/evidence')
      .set('Authorization', `Bearer ${workerToken}`)
      .send(evidenceBody(opened.id));
    assert.equal(noEvidence.status, 403);
    assert.equal(noEvidence.body.error.code, 'PERMISSION_DENIED');

    await q(`UPDATE form_instances SET status = 'COMPLETED' WHERE id = $1`, [
      opened.id,
    ]);
    const noReview = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${workerToken}`)
      .send({ targetType: 'FORM_INSTANCE', targetId: opened.id });
    assert.equal(noReview.status, 403);
    assert.equal(noReview.body.error.code, 'PERMISSION_DENIED');

    const evidenceOpen = await api()
      .post(`/api/v1/mobile/tasks/${taskId}/form-instance`)
      .set('Authorization', `Bearer ${evidenceToken}`);
    assert.equal(evidenceOpen.status, 403);
    assert.equal(evidenceOpen.body.error.code, 'PERMISSION_DENIED');

    const reviewOpen = await api()
      .post(`/api/v1/mobile/tasks/${taskId}/form-instance`)
      .set('Authorization', `Bearer ${reviewToken}`);
    assert.equal(reviewOpen.status, 403);
    assert.equal(reviewOpen.body.error.code, 'PERMISSION_DENIED');
  });

  it('assignment loss, off-shift, retired version, and terminal task block later Form mutations', async (t) => {
    if (!ready(t)) return;

    const lost = await createGeneratedTask('FORM_VERSION', publishedVersionId);
    await assignToWorker(lost);
    const lostInstance = await openFormInstanceForTask(
      lost,
      workerUserId,
      ON_SHIFT,
    );
    await q(`UPDATE task_assignments SET status = 'INACTIVE' WHERE task_id = $1`, [
      lost,
    ]);
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(lostInstance.id, workerUserId, ON_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );

    const off = await createGeneratedTask('FORM_VERSION', publishedVersionId);
    await assignToWorker(off);
    const offInstance = await openFormInstanceForTask(
      off,
      workerUserId,
      ON_SHIFT,
    );
    assert.equal(
      await errorCodeOf(
        startMobileFormInstance(offInstance.id, workerUserId, OFF_SHIFT),
      ),
      'CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT',
    );

    const retiredVersion = await seedPublishedVersion();
    const retiredTask = await createGeneratedTask(
      'FORM_VERSION',
      retiredVersion.versionId,
    );
    await assignToWorker(retiredTask);
    const retiredInstance = await openFormInstanceForTask(
      retiredTask,
      workerUserId,
      ON_SHIFT,
    );
    await q(
      `UPDATE form_template_versions SET status = 'RETIRED' WHERE id = $1`,
      [retiredVersion.versionId],
    );
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(retiredInstance.id, workerUserId, ON_SHIFT),
      ),
      'Only published template versions can create instances.',
    );

    const terminalTask = await createGeneratedTask(
      'FORM_VERSION',
      publishedVersionId,
      'COMPLETED',
    );
    await assignToWorker(terminalTask);
    const terminalInstance = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: publishedVersionId,
      generated_task_id: terminalTask,
      status: 'DRAFT',
    });
    assert.equal(
      await errorMessageOf(
        startMobileFormInstance(terminalInstance, workerUserId, ON_SHIFT),
      ),
      'Task is already terminal.',
    );
  });

  it('cancel stays bound and does not mutate the generated task', async (t) => {
    if (!ready(t)) return;
    const taskId = await createGeneratedTask('FORM_VERSION', publishedVersionId);
    await assignToWorker(taskId);
    const opened = await openFormInstanceForTask(taskId, workerUserId, ON_SHIFT);
    const cancelled = await finishMobileFormInstance(
      opened.id,
      workerUserId,
      'cancel',
      ON_SHIFT,
    );
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.generated_task_id, taskId);
    assert.equal(await taskStatusOf(taskId), 'OPEN');
    const stored = await q(
      `SELECT id, generated_task_id, status FROM form_instances
        WHERE generated_task_id = $1`,
      [taskId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].id, opened.id);
    assert.equal(stored.rows[0].status, 'CANCELLED');
  });

  it('broken bound-task consistency fails closed for evidence and review', async (t) => {
    if (!ready(t)) return;
    const other = await seedPublishedVersion();
    const taskId = await createGeneratedTask('FORM_VERSION', publishedVersionId);
    await assignToWorker(taskId);
    const broken = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: other.versionId,
      generated_task_id: taskId,
      status: 'COMPLETED',
      completed_at: '2026-08-20T04:00:00Z',
    });
    const evidence = await api()
      .post('/api/v1/evidence')
      .set('Authorization', `Bearer ${evidenceToken}`)
      .send(evidenceBody(broken));
    assert.equal(evidence.status, 400);
    assert.equal(
      evidence.body.error.message,
      'Bound form instance is inconsistent with the task.',
    );
    const review = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${reviewToken}`)
      .send({ targetType: 'FORM_INSTANCE', targetId: broken });
    assert.equal(review.status, 400);
    assert.equal(
      review.body.error.message,
      'Bound form instance is inconsistent with the task.',
    );
  });
});
