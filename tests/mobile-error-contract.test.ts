import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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
import { roleService } from '../src/modules/roles';
import {
  categoryForError,
  isRetryableStatus,
} from '../src/shared/errors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25K — Mobile Error Contract (focused contract tests).
 *
 * Verifies the stable mobile error contract:
 *   - standard error code + human-readable message,
 *   - machine-readable category (validation / unauthorized / forbidden /
 *     not-found / conflict / server),
 *   - retryable flag (5xx/429 true; client errors false),
 *   - requestId correlation,
 *   - validation details where applicable,
 *   - resource/context reference where useful,
 *   - conflict metadata where applicable,
 *   - no stack traces or sensitive details leaked.
 */

const DB_PORT = 55449;
const DATA_DIR = '/tmp/asentra-be25k-pg';
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
let plainToken = '';

let clientA = '';
let buildingA = '';
let clientB = '';
let templateA = '';
let executionA = ''; // client A COMPLETED
let executionB = ''; // client B (cross-Client)

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

describe('BE-25K mobile error contract — category and retryable mapping', () => {
  it('maps status/code pairs to stable categories', () => {
    assert.equal(categoryForError(400, 'VALIDATION_ERROR'), 'VALIDATION');
    assert.equal(categoryForError(400, 'BAD_REQUEST'), 'BAD_REQUEST'); // generic 400 is not validation
    assert.equal(categoryForError(401, 'INVALID_SESSION'), 'UNAUTHORIZED');
    assert.equal(categoryForError(403, 'PERMISSION_DENIED'), 'FORBIDDEN');
    assert.equal(categoryForError(403, 'BUILDING_ACCESS_DENIED'), 'FORBIDDEN');
    assert.equal(categoryForError(404, 'NOT_FOUND'), 'NOT_FOUND');
    assert.equal(categoryForError(409, 'ROLE_CODE_ALREADY_EXISTS'), 'CONFLICT');
    assert.equal(categoryForError(429, 'AUTH_RATE_LIMITED'), 'RATE_LIMITED');
    assert.equal(categoryForError(500, 'INTERNAL_SERVER_ERROR'), 'SERVER');
    assert.equal(categoryForError(503, 'DATABASE_UNAVAILABLE'), 'SERVER');
  });

  it('flags retryable statuses (5xx and 429) only', () => {
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(403), false);
    assert.equal(isRetryableStatus(404), false);
    assert.equal(isRetryableStatus(409), false);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
  });
});

describe('BE-25K mobile error contract — HTTP envelope', () => {
  it('validation: 400 VALIDATION_ERROR with category, details, retryable=false, requestId', async () => {
    const response = await api().post('/api/v1/auth/login').send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.equal(response.body.error.category, 'VALIDATION');
    assert.equal(response.body.error.retryable, false);
    assert.ok(response.body.error.message);
    assert.ok(Array.isArray(response.body.error.details));
    assert.equal(
      response.body.error.requestId,
      response.headers['x-request-id'],
      'requestId matches the X-Request-ID header',
    );
  });

  it('unauthorized: 401 AUTHENTICATION_REQUIRED → UNAUTHORIZED, not retryable', async () => {
    const response = await api().get('/api/v1/auth/me');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(response.body.error.category, 'UNAUTHORIZED');
    assert.equal(response.body.error.retryable, false);
    assert.equal(response.body.error.requestId, response.headers['x-request-id']);
  });

  it('not found: unknown route → NOT_FOUND, not retryable', async () => {
    const response = await api().get('/api/v1/__mobile/does-not-exist');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.equal(response.body.error.category, 'NOT_FOUND');
    assert.equal(response.body.error.retryable, false);
  });

  it('server: 500 INTERNAL_SERVER_ERROR → SERVER, retryable=true, no stack leak', async () => {
    const response = await api({
      configure(application) {
        application.get('/api/v1/__mobile/boom', () => {
          throw new Error('mobile secret boom');
        });
      },
    }).get('/api/v1/__mobile/boom');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(response.body.error.category, 'SERVER');
    assert.equal(response.body.error.retryable, true);
    assert.doesNotMatch(JSON.stringify(response.body), /mobile secret boom/);
    assert.doesNotMatch(JSON.stringify(response.body), /stack/i);
  });
});

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
      user_building_assignments, checklist_templates, checklist_items,
      checklist_executions, checklist_item_responses, reviews,
      mobile_sync_idempotency
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();

  const a = await clientService.createClient({
    code: `CLI_K_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Contract Client A',
  });
  const propA = await propertyService.createProperty({
    clientId: a.id,
    code: `PROP_K_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Contract Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `BLD_K_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Contract Building A',
  });
  clientA = a.id;
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: buildingA.id,
  });

  const b = await clientService.createClient({
    code: `CLI_KB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Contract Client B',
  });
  const propB = await propertyService.createProperty({
    clientId: b.id,
    code: `PROP_KB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Contract Property B',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propB.id,
    code: `BLD_KB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Contract Building B',
  });
  clientB = b.id;

  templateA = await insertRow('checklist_templates', {
    client_id: clientA,
    code: `TPL_K_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Template',
    status: 'ACTIVE',
  });
  executionA = await insertRow('checklist_executions', {
    client_id: clientA,
    checklist_template_id: templateA,
    status: 'COMPLETED',
    completed_at: '2026-08-11T01:00:00Z',
  });

  const templateB = await insertRow('checklist_templates', {
    client_id: clientB,
    code: `TPL_KB_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Error Template B',
    status: 'ACTIVE',
  });
  executionB = await insertRow('checklist_executions', {
    client_id: clientB,
    checklist_template_id: templateB,
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

describe('BE-25K mobile error contract — authenticated errors (DB)', () => {
  it('forbidden: 403 PERMISSION_DENIED → FORBIDDEN, not retryable', async () => {
    const response = await api()
      .get('/api/v1/tasks')
      .set('Authorization', `Bearer ${plainToken}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.equal(response.body.error.category, 'FORBIDDEN');
    assert.equal(response.body.error.retryable, false);
    assert.equal(response.body.error.requestId, response.headers['x-request-id']);
  });

  it('conflict: 409 ROLE_CODE_ALREADY_EXISTS → CONFLICT, not retryable', async () => {
    const code = `DUP_${randomUUID().slice(0, 8).toUpperCase()}`;
    const first = await api()
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code, name: 'First' });
    assert.equal(first.status, 201);

    const duplicate = await api()
      .post('/api/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code, name: 'Duplicate' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ROLE_CODE_ALREADY_EXISTS');
    assert.equal(duplicate.body.error.category, 'CONFLICT');
    assert.equal(duplicate.body.error.retryable, false);
  });

  it('resource reference: mobile checklist 404 carries resource { type, id }', async () => {
    const missing = id();
    const response = await api()
      .get(`/api/v1/mobile/checklist-executions/${missing}`)
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.deepEqual(response.body.error.resource, {
      type: 'CHECKLIST_EXECUTION',
      id: missing,
    });
  });

  it('conflict metadata: immutable verification rejection carries current state + reload guidance', async () => {
    const first = await api()
      .post(`/api/v1/mobile/verification/CHECKLIST_EXECUTION/${executionA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'APPROVED', notes: 'ok' });
    assert.equal(first.status, 201);

    const second = await api()
      .post(`/api/v1/mobile/verification/CHECKLIST_EXECUTION/${executionA}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ decision: 'REJECTED' });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'BAD_REQUEST');
    assert.equal(second.body.error.category, 'BAD_REQUEST');
    assert.equal(second.body.error.retryable, false);
    assert.deepEqual(second.body.error.resource, {
      type: 'CHECKLIST_EXECUTION',
      id: executionA,
    });
    // Conflict metadata: current immutable state + reload guidance.
    assert.ok(second.body.error.conflict);
    assert.equal(second.body.error.conflict.current.verification.state, 'VERIFIED');
    assert.equal(second.body.error.conflict.guidance.action, 'reload');
    assert.equal(
      second.body.error.conflict.guidance.reloadEndpoint,
      `/mobile/verification/CHECKLIST_EXECUTION/${executionA}`,
    );
  });

  it('sync per-item errors carry resource references (BE-25K fields in results)', async () => {
    const response = await api()
      .post('/api/v1/mobile/sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        operations: [
          {
            operationId: 'k-sync-1',
            resourceType: 'CHECKLIST_RESPONSES',
            resourceId: executionB, // cross-Client → BUILDING_ACCESS_DENIED
            operation: 'SAVE',
            clientTimestamp: '2026-08-11T00:00:00.000Z',
            data: { responses: [] },
          },
        ],
      });
    assert.equal(response.status, 200);
    const result = response.body.data.results[0];
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'BUILDING_ACCESS_DENIED');
    assert.deepEqual(result.error.resource, {
      type: 'CHECKLIST_RESPONSES',
      id: executionB,
    });
  });
});
