import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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
 * BE-25E — Evidence Upload Contract (focused contract tests).
 *
 * Verifies the mobile evidence upload contract:
 *   - single-call upload with evidence requirement reference,
 *   - target task/checklist reference + Building context,
 *   - file metadata + captured_at,
 *   - upload status (UPLOADED / PENDING),
 *   - evidence type / requirement / context validation,
 *   - bytes stored via the storage abstraction (never in PostgreSQL),
 *   - no internal storage paths exposed,
 *   - strict accessible Client scope (BE-02G),
 *   - Web evidence endpoints remain untouched (download reuse).
 */

const DB_PORT = 55442;
const DATA_DIR = '/tmp/asentra-be25e-pg';
const STORAGE_DIR = resolve(process.env.EVIDENCE_STORAGE_DIR ?? '.data/evidence');
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

let clientA = '';
let clientB = '';
let templateA = '';
let executionA = ''; // DRAFT execution in client A
let executionB = ''; // DRAFT execution in client B (cross-Client)
let reqPhoto = ''; // template-level PHOTO (max 2) in client A
let reqPhotoCount = ''; // template-level PHOTO (max 2, dedicated count test)
let reqSignature = ''; // template-level SIGNATURE in client A
let reqClientB = ''; // template-level PHOTO in client B (client mismatch)
let taskBuildingId = '';

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

type UploadResponse = {
  status: number;
  body: any;
  headers: Record<string, any>;
  text: string;
};

async function uploadPhoto(
  token: string,
  executionId: string,
  options: {
    requirementId?: string;
    mimeType?: string;
    capturedAt?: string;
    withFile?: boolean;
  } = {},
): Promise<UploadResponse> {
  let request = api()
    .post('/api/v1/mobile/evidence')
    .set('Authorization', `Bearer ${token}`)
    .field('evidenceType', 'PHOTO')
    .field('executionType', 'CHECKLIST_EXECUTION')
    .field('executionId', executionId);
  if (options.requirementId) {
    request = request.field('evidenceRequirementId', options.requirementId);
  }
  if (options.capturedAt) {
    request = request.field('capturedAt', options.capturedAt);
  }
  if (options.withFile !== false) {
    request = request.attach('file', Buffer.from('fake-jpeg-bytes'), {
      filename: 'photo.jpg',
      contentType: options.mimeType ?? 'image/jpeg',
    });
  }
  return request;
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

  rmSync(STORAGE_DIR, { recursive: true, force: true });

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE users, roles, permissions, clients, properties, buildings,
      user_building_assignments, checklist_templates, checklist_items,
      checklist_executions, evidence_requirements, evidence_submissions,
      units_of_measure, generated_tasks, schedule_definitions
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;

  const a = await clientService.createClient({
    code: `CLI_E_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_E_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_E_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Building A',
  });
  clientA = a.id;
  taskBuildingId = buildingA.id;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA.id,
  });

  const b = await clientService.createClient({
    code: `CLI_EB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_EB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Property B',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_EB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Building B',
  });
  clientB = b.id;
  // Admin has NO assignment to building B.

  // Template + executions.
  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_E_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Template',
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'DRAFT',
  });

  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_EB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Template B',
    status: 'ACTIVE',
  });
  executionB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
    status: 'DRAFT',
  });

  // Evidence requirements.
  reqPhoto = await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
    maximum_count: 2,
    description: 'Photo of the work',
    status: 'ACTIVE',
  });
  // Dedicated template for the count-limit requirement (evidence_requirements
  // allows only one ACTIVE requirement per target).
  const templateCount = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_EC_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Count Template',
    status: 'ACTIVE',
  });
  reqPhotoCount = await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateCount,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
    maximum_count: 2,
    description: 'Counted photo',
    status: 'ACTIVE',
  });
  reqSignature = await insertRow('evidence_requirements', {
    client_id: clientA,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    evidence_type: 'SIGNATURE',
    required: false,
    minimum_count: 0,
    maximum_count: 1,
    description: 'Signature',
    status: 'ACTIVE',
  });
  reqClientB = await insertRow('evidence_requirements', {
    client_id: clientB,
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateB,
    evidence_type: 'PHOTO',
    required: true,
    minimum_count: 1,
    maximum_count: 2,
    description: 'Photo B',
    status: 'ACTIVE',
  });

  // A task targeting template A (Building context case).
  const scheduleId = await insertRow('schedule_definitions', {
    client_id: clientA,
    code: `SD_E_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Evidence Schedule',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    building_id: buildingA.id,
    start_at: '2026-08-01T00:00:00Z',
    timezone: 'UTC',
    status: 'ACTIVE',
  });
  await insertRow('generated_tasks', {
    client_id: clientA,
    schedule_definition_id: scheduleId,
    occurrence_at: '2026-08-06T01:00:00Z',
    target_type: 'CHECKLIST_TEMPLATE',
    target_id: templateA,
    building_id: buildingA.id,
    status: 'OPEN',
  });

  // Read-only user (evidence.read only).
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const password = 'ReadOnlyPass123';
  const user = await userService.createUser({
    email: `evidence-ro-${suffix.toLowerCase()}@example.com`,
    displayName: 'Evidence Read Only',
  });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const role = await roleService.createRole({
    code: `EVID_RO_${suffix}`,
    name: 'Evidence Read Only Role',
  });
  let permission = await permissionRepository.findByCode('evidence.read');
  if (!permission) {
    permission = await permissionService.createPermission({
      code: 'evidence.read',
      name: 'Read Evidence',
    });
  }
  await permissionService.assignPermissionToRole(role.id, permission.id);
  await roleService.assignRoleToUser(user.id, role.id);
  const login = await api().post('/api/v1/auth/login').send({
    email: user.email,
    password,
  });
  readOnlyToken = login.body.data.sessionToken as string;
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
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

describe('BE-25E mobile evidence upload — single-call upload contract', () => {
  it('uploads evidence with the full mobile contract', async () => {
    const response = await uploadPhoto(adminToken, executionA, {
      requirementId: reqPhoto,
      capturedAt: '2026-08-06T02:00:00Z',
    });
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'building',
      'clientId',
      'createdAt',
      'evidenceRequirement',
      'evidenceType',
      'file',
      'id',
      'status',
      'submittedByUserId',
      'target',
      'updatedAt',
    ]);
    assert.equal(data.clientId, clientA);
    assert.equal(data.evidenceType, 'PHOTO');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.submittedByUserId, adminUserId);

    // Evidence requirement reference.
    assert.deepEqual(data.evidenceRequirement, {
      id: reqPhoto,
      evidenceType: 'PHOTO',
      required: true,
      minimumCount: 1,
      maximumCount: 2,
      description: 'Photo of the work',
    });

    // Target task/checklist reference.
    assert.equal(data.target.executionType, 'CHECKLIST_EXECUTION');
    assert.equal(data.target.executionId, executionA);
    assert.equal(data.target.checklist.id, templateA);
    assert.ok(data.target.task);
    assert.equal(data.target.task.taskStatus, 'OPEN');
    assert.equal(data.target.task.occurrenceAt, '2026-08-06T01:00:00.000Z');
    assert.equal(data.target.task.buildingId, taskBuildingId);

    // Building context.
    assert.deepEqual(data.building, {
      id: taskBuildingId,
      code: data.building.code,
      name: 'Evidence Building A',
    });

    // File metadata + captured_at + upload status.
    assert.equal(data.file.originalFileName, 'photo.jpg');
    assert.equal(data.file.mimeType, 'image/jpeg');
    assert.ok(data.file.fileSize > 0);
    assert.equal(data.file.capturedAt, '2026-08-06T02:00:00.000Z');
    assert.equal(data.file.uploadStatus, 'UPLOADED');
    assert.equal(data.file.fileAvailable, true);
    assert.ok(!('fileReference' in data.file), 'storage key must not be exposed');

    return data.id as string;
  });

  it('stores the bytes via the storage abstraction and serves them through the existing download endpoint', async () => {
    const upload = await uploadPhoto(adminToken, executionA);
    assert.equal(upload.status, 201);
    const evidenceId = upload.body.data.id as string;

    // File exists under the storage directory (evidence/<uuid> key pattern).
    const storageFile = resolve(STORAGE_DIR, 'evidence', evidenceId);
    assert.ok(existsSync(storageFile), 'stored file must exist on disk');
    assert.equal(readFileSync(storageFile).toString(), 'fake-jpeg-bytes');

    // Reuse the CR-BE-API-01 download endpoint (Web behavior untouched).
    const download = await api()
      .get(`/api/v1/evidence/${evidenceId}/file/content`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(download.status, 200);
    assert.equal(download.body.toString(), 'fake-jpeg-bytes');
    assert.equal(download.headers['content-type'], 'image/jpeg');

    // No bytes in PostgreSQL.
    const row = await q('SELECT file_reference FROM evidence_submissions WHERE id = $1', [
      evidenceId,
    ]);
    assert.match(row.rows[0].file_reference, /^evidence\/[0-9a-f-]{36}$/);
  });

  it('GET /mobile/evidence/:id returns the reference contract (UPLOADED)', async () => {
    const upload = await uploadPhoto(adminToken, executionA);
    const evidenceId = upload.body.data.id as string;

    const response = await api()
      .get(`/api/v1/mobile/evidence/${evidenceId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.id, evidenceId);
    assert.equal(data.evidenceType, 'PHOTO');
    assert.equal(data.file.uploadStatus, 'UPLOADED');
    assert.equal(data.file.fileAvailable, true);
    assert.equal(data.target.executionId, executionA);
  });

  it('reports PENDING upload status for metadata-only submissions', async () => {
    const metadataOnly = await insertRow('evidence_submissions', {
      client_id: clientA,
      evidence_requirement_id: null,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: executionA,
      evidence_type: 'PHOTO',
      file_reference: 'legacy-reference-value',
      original_file_name: 'queued.jpg',
      mime_type: 'image/jpeg',
      file_size: 10,
      captured_at: null,
      submitted_by_user_id: adminUserId,
      status: 'ACTIVE',
    });
    const response = await api()
      .get(`/api/v1/mobile/evidence/${metadataOnly}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    const data = response.body.data;
    assert.equal(data.file.uploadStatus, 'PENDING');
    assert.equal(data.file.fileAvailable, false);
    assert.equal(data.evidenceRequirement, null);
    // Building/task context is resolved from the target (task-bound
    // template), not from the file — so it is present even for PENDING rows.
    assert.equal(data.building.id, taskBuildingId);
    assert.ok(data.target.task);
  });
});

describe('BE-25E mobile evidence upload — validation (backend-authoritative)', () => {
  it('rejects an unknown execution and a missing file', async () => {
    const unknown = await uploadPhoto(adminToken, id());
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'BAD_REQUEST');

    const missingFile = await uploadPhoto(adminToken, executionA, { withFile: false });
    assert.equal(missingFile.status, 400);
    assert.equal(missingFile.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      missingFile.body.error.details.some(
        (detail: { field: string }) => detail.field === 'file',
      ),
    );
  });

  it('rejects a MIME type that does not match the evidence type', async () => {
    const response = await uploadPhoto(adminToken, executionA, {
      mimeType: 'text/plain',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });

  it('rejects a requirement whose evidence type does not match', async () => {
    const response = await uploadPhoto(adminToken, executionA, {
      requirementId: reqSignature,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });

  it('rejects a requirement that belongs to another Client', async () => {
    const response = await uploadPhoto(adminToken, executionA, {
      requirementId: reqClientB,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });

  it('rejects uploads beyond the requirement maximum count', async () => {
    const first = await uploadPhoto(adminToken, executionA, {
      requirementId: reqPhotoCount,
    });
    assert.equal(first.status, 201);
    const second = await uploadPhoto(adminToken, executionA, {
      requirementId: reqPhotoCount,
    });
    assert.equal(second.status, 201);
    const third = await uploadPhoto(adminToken, executionA, {
      requirementId: reqPhotoCount,
    });
    assert.equal(third.status, 400);
    assert.equal(third.body.error.code, 'BAD_REQUEST');
  });

  it('rejects evidence for a terminal execution', async () => {
    await q(
      `UPDATE checklist_executions SET status = 'COMPLETED' WHERE id = $1`,
      [executionA],
    );
    const response = await uploadPhoto(adminToken, executionA);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });

  it('rejects an invalid capturedAt timestamp', async () => {
    const fresh = await insertRow('checklist_executions', {
      client_id: clientA,
      checklist_template_id: templateA,
      status: 'DRAFT',
    });
    const response = await uploadPhoto(adminToken, fresh, {
      capturedAt: 'not-a-date',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'capturedAt',
      ),
    );
  });
});

describe('BE-25E mobile evidence upload — scope and permissions', () => {
  it('returns 403 for a cross-Client execution (BE-02G)', async () => {
    const response = await uploadPhoto(adminToken, executionB);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('returns 403 for GET on cross-Client evidence', async () => {
    const crossEvidence = await insertRow('evidence_submissions', {
      client_id: clientB,
      evidence_requirement_id: null,
      execution_type: 'CHECKLIST_EXECUTION',
      execution_id: executionB,
      evidence_type: 'PHOTO',
      file_reference: 'evidence/00000000-0000-0000-0000-000000000000',
      original_file_name: 'cross.jpg',
      mime_type: 'image/jpeg',
      file_size: 1,
      captured_at: null,
      submitted_by_user_id: adminUserId,
      status: 'ACTIVE',
    });
    const response = await api()
      .get(`/api/v1/mobile/evidence/${crossEvidence}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('requires authentication and evidence.manage for upload', async () => {
    const anonymous = await api().post('/api/v1/mobile/evidence');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await uploadPhoto(readOnlyToken, executionA);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns 404 for an unknown evidence reference', async () => {
    const response = await api()
      .get(`/api/v1/mobile/evidence/${id()}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});
