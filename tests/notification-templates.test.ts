import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  getActiveTemplateByKey,
  renderTemplate,
} from '../src/modules/notification-templates';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26B — Notification template foundation (focused contract tests).
 *
 * Verifies the reusable template record + rendering recipe:
 *   - template key / notification type / channel / subject / body /
 *     declared variables / active status,
 *   - placeholder ↔ variable consistency (no undeclared references),
 *   - RBAC (notification_template.read / .manage, default-deny),
 *   - unique key enforcement,
 *   - pure render substitution + missing-variable guard,
 *   - active-template lookup by key.
 *
 * Foundation only: no recipient resolution and no sending are exercised here.
 */

const DB_PORT = 55453;
const DATA_DIR = '/tmp/asentra-be26b-pg';
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
let readOnlyToken = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function createTemplate(token: string, body: Record<string, unknown>) {
  return api()
    .post('/api/v1/notification-templates')
    .set(auth(token))
    .send(body);
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
    `TRUNCATE notification_templates, permissions, roles, users CASCADE`,
  );

  adminToken = await createAdminUser().then((a) => a.token);
  readOnlyToken = await createSessionWithPermissions([
    { code: 'notification_template.read', name: 'Read Notification Templates' },
  ]);
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

describe('BE-26B notification templates — create', () => {
  it('creates a template with the full record (key, type, channel, subject, body, variables, status)', async () => {
    const response = await createTemplate(adminToken, {
      key: 'work_order_assigned',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      subject: 'Work order {{workOrderNumber}} assigned',
      body: 'A work order was assigned to {{assignee}} in {{buildingName}}.',
      variables: ['workOrderNumber', 'assignee', 'buildingName'],
    });
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'body',
      'channel',
      'createdAt',
      'id',
      'key',
      'status',
      'subject',
      'type',
      'updatedAt',
      'variables',
    ]);
    assert.equal(data.key, 'WORK_ORDER_ASSIGNED', 'key normalized to uppercase');
    assert.equal(data.type, 'WORK_ORDER_ASSIGNED');
    assert.equal(data.channel, 'IN_APP');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(
      data.subject,
      'Work order {{workOrderNumber}} assigned',
    );
    assert.deepEqual(data.variables, ['workOrderNumber', 'assignee', 'buildingName']);
    assert.ok(!Number.isNaN(Date.parse(data.createdAt)));
  });

  it('rejects an unsupported channel (only IN_APP exists)', async () => {
    const response = await createTemplate(adminToken, {
      key: 'push_template',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'PUSH',
      subject: 'Hello',
      variables: [],
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'channel',
      ),
    );
  });

  it('rejects a template referencing an undeclared variable', async () => {
    const response = await createTemplate(adminToken, {
      key: 'undeclared_var',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      subject: 'Hello {{missingName}}',
      variables: ['declaredName'],
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string; message: string }) =>
          detail.field === 'variables' &&
          detail.message.includes('missingName'),
      ),
    );
  });

  it('rejects a duplicate template key (409)', async () => {
    const first = await createTemplate(adminToken, {
      key: 'duplicate_key',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      subject: 'First',
      variables: [],
    });
    assert.equal(first.status, 201);

    const second = await createTemplate(adminToken, {
      key: 'duplicate_key',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      subject: 'Second',
      variables: [],
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'NOTIFICATION_TEMPLATE_KEY_ALREADY_EXISTS');
  });

  it('requires notification_template.manage (read-only user gets 403)', async () => {
    const response = await createTemplate(readOnlyToken, {
      key: 'no_permission',
      type: 'WORK_ORDER_ASSIGNED',
      channel: 'IN_APP',
      subject: 'Nope',
      variables: [],
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('BE-26B notification templates — list / get', () => {
  it('lists templates ordered by key and filters by status', async () => {
    await createTemplate(adminToken, {
      key: 'z_last',
      type: 'TYPE_Z',
      channel: 'IN_APP',
      subject: 'Z',
      variables: [],
    });
    await createTemplate(adminToken, {
      key: 'a_first',
      type: 'TYPE_A',
      channel: 'IN_APP',
      subject: 'A',
      variables: [],
    });

    const list = await api()
      .get('/api/v1/notification-templates')
      .set(auth(adminToken));
    assert.equal(list.status, 200);
    const keys = (list.body.data as { key: string }[]).map((item) => item.key);
    assert.ok(keys.indexOf('A_FIRST') < keys.indexOf('Z_LAST'), 'ordered by key');

    const activeOnly = await api()
      .get('/api/v1/notification-templates?status=ACTIVE')
      .set(auth(adminToken));
    assert.equal(activeOnly.status, 200);
    assert.ok(
      (activeOnly.body.data as { status: string }[]).every(
        (item) => item.status === 'ACTIVE',
      ),
    );

    const bad = await api()
      .get('/api/v1/notification-templates?status=GONE')
      .set(auth(adminToken));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  });

  it('gets a template by id, rejects invalid id and missing template', async () => {
    const created = await createTemplate(adminToken, {
      key: 'get_me',
      type: 'TYPE_GET',
      channel: 'IN_APP',
      subject: 'Get me',
      variables: [],
    });
    const id = created.body.data.id as string;

    const got = await api()
      .get(`/api/v1/notification-templates/${id}`)
      .set(auth(adminToken));
    assert.equal(got.status, 200);
    assert.equal(got.body.data.key, 'GET_ME');

    const missing = await api()
      .get(`/api/v1/notification-templates/${randomUUID()}`)
      .set(auth(adminToken));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOTIFICATION_TEMPLATE_NOT_FOUND');

    const badId = await api()
      .get('/api/v1/notification-templates/not-a-uuid')
      .set(auth(adminToken));
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires notification_template.read (unauthenticated gets 401)', async () => {
    const anon = await api().get('/api/v1/notification-templates');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-26B notification templates — update', () => {
  it('updates subject/body/variables/status and deactivates', async () => {
    const created = await createTemplate(adminToken, {
      key: 'updatable',
      type: 'TYPE_UPDATE',
      channel: 'IN_APP',
      subject: 'Hello {{a}}',
      body: 'Body {{a}}',
      variables: ['a'],
    });
    const id = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/notification-templates/${id}`)
      .set(auth(adminToken))
      .send({
        subject: 'Hi {{a}} and {{b}}',
        body: 'Updated body {{b}}',
        variables: ['a', 'b'],
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.subject, 'Hi {{a}} and {{b}}');
    assert.deepEqual(updated.body.data.variables, ['a', 'b']);

    const deactivated = await api()
      .patch(`/api/v1/notification-templates/${id}`)
      .set(auth(adminToken))
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
  });

  it('rejects an update that references an undeclared variable (merged content)', async () => {
    const created = await createTemplate(adminToken, {
      key: 'merge_check',
      type: 'TYPE_MERGE',
      channel: 'IN_APP',
      subject: 'Hello {{a}}',
      variables: ['a'],
    });
    const id = created.body.data.id as string;

    // body introduces {{b}} while variables still declare only ['a'].
    const response = await api()
      .patch(`/api/v1/notification-templates/${id}`)
      .set(auth(adminToken))
      .send({ body: 'Now with {{b}}' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects changing the immutable template key', async () => {
    const created = await createTemplate(adminToken, {
      key: 'immutable_key',
      type: 'TYPE_IMMUTABLE',
      channel: 'IN_APP',
      subject: 'Immutable',
      variables: [],
    });
    const id = created.body.data.id as string;

    const response = await api()
      .patch(`/api/v1/notification-templates/${id}`)
      .set(auth(adminToken))
      .send({ key: 'CHANGED_KEY' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'key',
      ),
    );
  });
});

describe('BE-26B notification templates — render + active lookup', () => {
  it('renderTemplate substitutes declared variables (pure)', async () => {
    const rendered = renderTemplate(
      {
        subject: 'Work order {{workOrderNumber}} assigned',
        body: 'Assigned to {{assignee}} in {{buildingName}}.',
      },
      {
        workOrderNumber: 'WO-2026-0001',
        assignee: 'John',
        buildingName: 'Graha Mampang',
      },
    );
    assert.deepEqual(rendered, {
      subject: 'Work order WO-2026-0001 assigned',
      body: 'Assigned to John in Graha Mampang.',
    });
  });

  it('renderTemplate throws when a placeholder has no value', () => {
    assert.throws(
      () =>
        renderTemplate(
          { subject: 'Hello {{name}}', body: null },
          { other: 'value' },
        ),
      (error: { code?: string }) => error.code === 'VALIDATION_ERROR',
    );
  });

  it('getActiveTemplateByKey returns the ACTIVE template, null when inactive', async () => {
    const created = await createTemplate(adminToken, {
      key: 'active_lookup',
      type: 'TYPE_LOOKUP',
      channel: 'IN_APP',
      subject: 'Lookup {{a}}',
      variables: ['a'],
    });
    const id = created.body.data.id as string;

    const active = await getActiveTemplateByKey('ACTIVE_LOOKUP');
    assert.ok(active, 'active template resolved');
    assert.equal(active.subject, 'Lookup {{a}}');

    await api()
      .patch(`/api/v1/notification-templates/${id}`)
      .set(auth(adminToken))
      .send({ status: 'INACTIVE' });

    const inactive = await getActiveTemplateByKey('ACTIVE_LOOKUP');
    assert.equal(inactive, null, 'inactive template not resolved');

    const missing = await getActiveTemplateByKey('DOES_NOT_EXIST');
    assert.equal(missing, null);
  });
});
