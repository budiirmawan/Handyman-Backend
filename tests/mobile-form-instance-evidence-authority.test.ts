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
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * MOB-C07 PART 05 — task-bound FORM_INSTANCE evidence + verification
 * authority. Reuses the shared evidence/review subsystems; bound instances
 * derive Building from generated_task_id. Unbound generic instances stay
 * Client-scoped. Current shift is not required. Permissions remain
 * evidence.manage / review.manage (not form_instance.execute).
 */

const DB_PORT = 55499;
const DATA_DIR = '/tmp/asentra-mob-c07-p05-pg';
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

let evidenceToken = '';
let evidenceReadToken = '';
let executeToken = '';
let reviewToken = '';
let evidenceBuildingBToken = '';
let reviewBuildingBToken = '';

let clientA = '';
let buildingA = '';
let buildingACode = '';
let buildingAName = '';
let buildingB = '';

let publishedVersionId = '';
let otherVersionId = '';
let formTemplateId = '';
let unboundInstanceId = '';
let boundDraftId = '';
let boundTaskId = '';
let boundCompletedId = '';
let boundCompletedTaskId = '';
let mismatchInstanceId = '';

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

async function createUser(
  prefix: string,
  codes: { code: string; name: string }[],
): Promise<{ userId: string; token: string }> {
  const password = 'FormEvPass123';
  const user = await userService.createUser({
    email: `${prefix}-${suffix().toLowerCase()}@example.com`,
    displayName: 'Form Evidence User',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `${prefix.toUpperCase()}_${suffix()}`,
    name: 'Form Evidence Role',
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

async function seedFormVersion(clientId: string): Promise<{
  templateId: string;
  versionId: string;
}> {
  const sourceId = await insertRow('source_forms', {
    client_id: clientId,
    code: `SRC_${suffix()}`,
    name: 'Source',
    source_type: 'INTERNAL',
    status: 'ACTIVE',
  });
  const templateId = await insertRow('form_templates', {
    source_form_id: sourceId,
    client_id: clientId,
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
  return { templateId, versionId };
}

async function createGeneratedTask(
  clientId: string,
  buildingId: string,
  versionId: string,
): Promise<string> {
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientId,
    code: `SD_${suffix()}`,
    name: 'Form schedule',
    target_type: 'FORM_VERSION',
    target_id: versionId,
    building_id: buildingId,
    start_at: '2026-08-01T00:00:00Z',
    timezone: TZ,
    status: 'ACTIVE',
  });
  return insertRow('generated_tasks', {
    client_id: clientId,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-05T01:00:00Z',
    target_type: 'FORM_VERSION',
    target_id: versionId,
    building_id: buildingId,
    status: 'OPEN',
  });
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

function postEvidence(token: string, executionId: string) {
  return api()
    .post('/api/v1/evidence')
    .set('Authorization', `Bearer ${token}`)
    .send(evidenceBody(executionId));
}

async function taskStatusOf(taskId: string): Promise<string> {
  const result = await q('SELECT status FROM generated_tasks WHERE id = $1', [
    taskId,
  ]);
  return result.rows[0].status as string;
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
      user_building_assignments, schedule_definitions, generated_tasks,
      form_responses, form_instances, form_template_version_fields,
      form_template_version_sections, form_template_versions, form_fields,
      form_sections, form_templates, source_forms, evidence_submissions,
      reviews
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
  buildingACode = bA.code;
  buildingAName = bA.name;
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
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingB,
  });

  const evidence = await createUser('evman', [
    { code: 'evidence.manage', name: 'Manage Evidence' },
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  evidenceToken = evidence.token;
  await buildingAssignmentService.createAssignment(evidence.userId, {
    buildingId: buildingA,
  });

  const evidenceRead = await createUser('evread', [
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  evidenceReadToken = evidenceRead.token;
  await buildingAssignmentService.createAssignment(evidenceRead.userId, {
    buildingId: buildingA,
  });

  const execute = await createUser('fexec', [
    { code: 'form_instance.execute', name: 'Execute Form Instances' },
  ]);
  executeToken = execute.token;
  await buildingAssignmentService.createAssignment(execute.userId, {
    buildingId: buildingA,
  });

  const review = await createUser('revman', [
    { code: 'review.manage', name: 'Manage Reviews' },
    { code: 'review.read', name: 'Read Reviews' },
  ]);
  reviewToken = review.token;
  await buildingAssignmentService.createAssignment(review.userId, {
    buildingId: buildingA,
  });

  const evidenceB = await createUser('evb', [
    { code: 'evidence.manage', name: 'Manage Evidence' },
    { code: 'evidence.read', name: 'Read Evidence' },
  ]);
  evidenceBuildingBToken = evidenceB.token;
  await buildingAssignmentService.createAssignment(evidenceB.userId, {
    buildingId: buildingB,
  });

  const reviewB = await createUser('revb', [
    { code: 'review.manage', name: 'Manage Reviews' },
    { code: 'review.read', name: 'Read Reviews' },
  ]);
  reviewBuildingBToken = reviewB.token;
  await buildingAssignmentService.createAssignment(reviewB.userId, {
    buildingId: buildingB,
  });

  const published = await seedFormVersion(clientA);
  formTemplateId = published.templateId;
  publishedVersionId = published.versionId;
  otherVersionId = (await seedFormVersion(clientA)).versionId;

  unboundInstanceId = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: publishedVersionId,
    status: 'DRAFT',
  });

  boundTaskId = await createGeneratedTask(clientA, buildingA, publishedVersionId);
  boundDraftId = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: publishedVersionId,
    generated_task_id: boundTaskId,
    status: 'DRAFT',
  });

  boundCompletedTaskId = await createGeneratedTask(
    clientA,
    buildingA,
    publishedVersionId,
  );
  boundCompletedId = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: publishedVersionId,
    generated_task_id: boundCompletedTaskId,
    status: 'COMPLETED',
    completed_at: '2026-08-20T04:00:00Z',
  });

  const mismatchTask = await createGeneratedTask(
    clientA,
    buildingA,
    publishedVersionId,
  );
  mismatchInstanceId = await insertRow('form_instances', {
    client_id: clientA,
    form_template_version_id: otherVersionId,
    generated_task_id: mismatchTask,
    status: 'DRAFT',
  });
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

describe('MOB-C07 PART 05 — task-bound FORM_INSTANCE evidence', () => {
  it('uploads bound FORM_INSTANCE evidence with evidence.manage and Building access', async (t) => {
    if (!ready(t)) return;
    const before = await taskStatusOf(boundTaskId);
    const response = await postEvidence(evidenceToken, boundDraftId);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.executionType, 'FORM_INSTANCE');
    assert.equal(response.body.data.executionId, boundDraftId);
    assert.equal(response.body.data.clientId, clientA);
    assert.equal(await taskStatusOf(boundTaskId), before);
  });

  it('mobile read returns the exact Form Instance and Building from the generated task', async (t) => {
    if (!ready(t)) return;
    const created = await postEvidence(evidenceToken, boundDraftId);
    const response = await api()
      .get(`/api/v1/mobile/evidence/${created.body.data.id}`)
      .set('Authorization', `Bearer ${evidenceReadToken}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.target.executionType, 'FORM_INSTANCE');
    assert.equal(response.body.data.target.executionId, boundDraftId);
    assert.equal(response.body.data.target.form.id, formTemplateId);
    assert.equal(response.body.data.target.task.taskId, boundTaskId);
    assert.equal(response.body.data.target.task.buildingId, buildingA);
    assert.deepEqual(response.body.data.building, {
      id: buildingA,
      code: buildingACode,
      name: buildingAName,
    });
  });

  it('fails closed on a version/task mismatch', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(evidenceToken, mismatchInstanceId);
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.message,
      'Bound form instance is inconsistent with the task.',
    );
  });

  it('denies an inaccessible Building even when the Client is reachable', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(evidenceBuildingBToken, boundDraftId);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('form_instance.execute without evidence.manage cannot upload', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(executeToken, boundDraftId);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('unbound generic FORM_INSTANCE evidence remains Client-scoped', async (t) => {
    if (!ready(t)) return;
    const response = await postEvidence(evidenceToken, unboundInstanceId);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.executionId, unboundInstanceId);
    const read = await api()
      .get(`/api/v1/mobile/evidence/${response.body.data.id}`)
      .set('Authorization', `Bearer ${evidenceReadToken}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.target.executionType, 'FORM_INSTANCE');
    assert.equal(read.body.data.target.task, null);
    assert.equal(read.body.data.building, null);
  });
});

describe('MOB-C07 PART 05 — task-bound FORM_INSTANCE verification', () => {
  it('reviews a bound COMPLETED instance with review.manage and Building access', async (t) => {
    if (!ready(t)) return;
    const before = await taskStatusOf(boundCompletedTaskId);
    const created = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${reviewToken}`)
      .send({
        targetType: 'FORM_INSTANCE',
        targetId: boundCompletedId,
        notes: 'ok',
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.targetType, 'FORM_INSTANCE');
    assert.equal(created.body.data.targetId, boundCompletedId);
    assert.equal(created.body.data.clientId, clientA);

    const mobile = await api()
      .get(`/api/v1/mobile/verification/FORM_INSTANCE/${boundCompletedId}`)
      .set('Authorization', `Bearer ${reviewToken}`);
    assert.equal(mobile.status, 200, JSON.stringify(mobile.body));
    assert.equal(mobile.body.data.buildingId, buildingA);
    assert.equal(mobile.body.data.resource.form.id, formTemplateId);

    const decided = await api()
      .post(`/api/v1/reviews/${created.body.data.id}/decision`)
      .set('Authorization', `Bearer ${reviewToken}`)
      .send({ decision: 'APPROVED' });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(await taskStatusOf(boundCompletedTaskId), before);
    assert.equal(await taskStatusOf(boundCompletedTaskId), 'OPEN');
  });

  it('fails closed on a broken bound parent chain', async (t) => {
    if (!ready(t)) return;
    const brokenTask = await createGeneratedTask(
      clientA,
      buildingA,
      publishedVersionId,
    );
    const broken = await insertRow('form_instances', {
      client_id: clientA,
      form_template_version_id: otherVersionId,
      generated_task_id: brokenTask,
      status: 'COMPLETED',
      completed_at: '2026-08-20T04:00:00Z',
    });
    const response = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${reviewToken}`)
      .send({ targetType: 'FORM_INSTANCE', targetId: broken });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.message,
      'Bound form instance is inconsistent with the task.',
    );
  });

  it('form_instance.execute does not grant review authority', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${executeToken}`)
      .send({
        targetType: 'FORM_INSTANCE',
        targetId: boundCompletedId,
      });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies review when the bound Building is inaccessible', async (t) => {
    if (!ready(t)) return;
    const response = await api()
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${reviewBuildingBToken}`)
      .send({
        targetType: 'FORM_INSTANCE',
        targetId: boundCompletedId,
      });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
