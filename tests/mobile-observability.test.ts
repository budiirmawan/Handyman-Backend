import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { resolveMobileContext } from '../src/middleware/mobile-context';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25N — Mobile Observability (focused contract tests).
 *
 * Verifies lightweight backend observability for mobile API usage:
 *   - mobile request correlation id (X-Request-ID everywhere + diagnostics),
 *   - device/app version metadata capture (sanitized; invalid ignored),
 *   - sync operation trace/reference (batchId in responses; per-item
 *     failure logging does not leak into responses),
 *   - error/event logging does NOT expose stack traces or sensitive data,
 *   - basic mobile API health/diagnostic metadata endpoint.
 */

const DB_PORT = 55452;
const DATA_DIR = '/tmp/asentra-be25n-pg';
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
      checklist_executions, mobile_sync_idempotency
     CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;

  // A client + DRAFT execution for the sync trace test.
  const client = await (await import('../src/modules/clients')).clientService.createClient({
    code: `CLI_N_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Observability Client',
  });
  const template = await insertRow('checklist_templates', {
    client_id: client.id,
    code: `TPL_N_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Obs Template',
    status: 'ACTIVE',
  });
  await insertRow('checklist_executions', {
    client_id: client.id,
    checklist_template_id: template,
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

describe('BE-25N mobile observability — mobile context capture', () => {
  it('captures sanitized device/app metadata from headers', () => {
    const req = {
      header: (name: string) =>
        ({
          'x-device-id': 'device-obs-1',
          'x-platform': 'android',
          'x-app-version': '1.2.3',
        })[name],
    } as any;

    const context = resolveMobileContext(req);
    assert.deepEqual(context, {
      deviceId: 'device-obs-1',
      platform: 'ANDROID', // normalized
      appVersion: '1.2.3',
    });
  });

  it('ignores invalid or missing mobile headers (never breaks the API)', () => {
    const req = {
      header: (name: string) =>
        ({
          'x-device-id': 'bad device id with spaces!',
          'x-platform': 'WEB',
          'x-app-version': 'v1.2.3 (beta)',
        })[name],
    } as any;

    const context = resolveMobileContext(req);
    assert.deepEqual(context, {
      deviceId: null,
      platform: null,
      appVersion: null,
    });
  });

  it('every response carries the X-Request-ID correlation header', async () => {
    const response = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers['x-request-id']);

    const errorResponse = await api().get('/api/v1/mobile/diagnostics');
    assert.equal(errorResponse.status, 401);
    assert.ok(errorResponse.headers['x-request-id']);
  });
});

describe('BE-25N mobile observability — diagnostics endpoint', () => {
  it('returns basic mobile API health/diagnostic metadata (authenticated)', async () => {
    const response = await api()
      .get('/api/v1/mobile/diagnostics')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Device-Id', 'device-diag-1')
      .set('X-Platform', 'IOS')
      .set('X-App-Version', '2.0.0');
    assert.equal(response.status, 200);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'device',
      'requestId',
      'serverTime',
      'status',
      'uptimeSeconds',
    ]);
    assert.equal(data.status, 'OK');
    assert.equal(data.requestId, response.headers['x-request-id'], 'correlation id echoed');
    assert.ok(!Number.isNaN(Date.parse(data.serverTime)));
    assert.ok(data.uptimeSeconds >= 0);
    assert.deepEqual(data.device, {
      deviceId: 'device-diag-1',
      platform: 'IOS',
      appVersion: '2.0.0',
    });
  });

  it('omits the device echo when no mobile headers are sent', async () => {
    const response = await api()
      .get('/api/v1/mobile/diagnostics')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(response.status, 200);
    assert.ok(!('device' in response.body.data));
  });

  it('requires authentication', async () => {
    const response = await api().get('/api/v1/mobile/diagnostics');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-25N mobile observability — sync trace and error hygiene', () => {
  it('sync responses carry a batchId trace reference and never leak internals', async () => {
    const execution = (
      await q('SELECT id FROM checklist_executions LIMIT 1')
    ).rows[0] as { id: string };

    const response = await api()
      .post('/api/v1/mobile/sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Device-Id', 'device-sync-1')
      .send({
        operations: [
          {
            operationId: 'obs-sync-1',
            resourceType: 'CHECKLIST_RESPONSES',
            resourceId: execution.id,
            operation: 'SAVE',
            clientTimestamp: '2026-08-12T00:00:00.000Z',
            data: { responses: [] },
          },
          {
            operationId: 'obs-sync-fail',
            resourceType: 'CHECKLIST_RESPONSES',
            resourceId: id(), // unknown execution → per-item failure
            operation: 'SAVE',
            clientTimestamp: '2026-08-12T00:00:00.000Z',
            data: { responses: [] },
          },
        ],
      });
    assert.equal(response.status, 200);
    const batch = response.body.data;
    assert.ok(batch.batchId, 'batchId trace reference present');
    assert.equal(batch.results.length, 2);

    const failed = batch.results.find((r: any) => r.operationId === 'obs-sync-fail');
    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'NOT_FOUND');
    assert.deepEqual(failed.error.resource, {
      type: 'CHECKLIST_RESPONSES',
      id: failed.error.resource.id,
    });

    // No stack traces / internals in the response.
    assert.doesNotMatch(JSON.stringify(batch), /stack|at /i);
  });

  it('mobile API failures never expose stack traces or sensitive details', async () => {
    const response = await api({
      configure(application) {
        application.get('/api/v1/__obs/boom', () => {
          throw new Error('observability secret');
        });
      },
    })
      .get('/api/v1/__obs/boom')
      .set('X-Device-Id', 'device-boom-1');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
    assert.doesNotMatch(JSON.stringify(response.body), /observability secret/);
    assert.doesNotMatch(JSON.stringify(response.body), /stack/i);
    // The error still carries the correlation id for log correlation.
    assert.equal(response.body.error.requestId, response.headers['x-request-id']);
  });

  it('preserves existing Web/API behavior (plain requests unaffected)', async () => {
    const health = await api().get('/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');

    // A non-mobile request to diagnostics works and echoes no device.
    const diagnostics = await api()
      .get('/api/v1/mobile/diagnostics')
      .set('Authorization', `Bearer ${adminToken}`);
    assert.equal(diagnostics.status, 200);
    assert.ok(!('device' in diagnostics.body.data));
  });
});
