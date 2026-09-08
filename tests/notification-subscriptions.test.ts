import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { parseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { findMatchingSubscriptions } from '../src/modules/notification-subscriptions';
import { createAdminUser, createSessionWithPermissions } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-26D — Notification event subscription (focused tests).
 *
 * Verifies the declarative event→trigger mapping:
 *   - subscription record (key, eventType, templateKey, recipientRule,
 *     clientId/buildingId context, status),
 *   - template reference validation,
 *   - recipient rule validation (reuses BE-26C),
 *   - Client/Building context consistency,
 *   - RBAC (notification_subscription.read / .manage, default-deny),
 *   - event matching seam (findMatchingSubscriptions) honoring context +
 *     enabled status.
 *
 * No delivery, no in-app execution, no new domain events.
 */

const DB_PORT = 55455;
const DATA_DIR = '/tmp/asentra-be26d-pg';
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

let clientA = '';
let clientB = '';
let buildingA1 = '';

const id = () => randomUUID();
const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function insertRow(
  table: string,
  values: Record<string, unknown>,
  rowId = id(),
): Promise<string> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 2}`);
  await q(
    `INSERT INTO ${table} (id, ${columns.join(', ')})
     VALUES ($1, ${placeholders.join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

async function insertTemplate(key: string): Promise<string> {
  return insertRow('notification_templates', {
    key,
    type: key,
    channel: 'IN_APP',
    subject: 'Hello {{who}}',
    body: null,
    variables: JSON.stringify(['who']),
    status: 'ACTIVE',
  });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const WORK_ORDER_RULE = {
  specs: [{ kind: 'TEAM', teamId: randomUUID() }],
};

function createSubscription(token: string, body: Record<string, unknown>) {
  return api()
    .post('/api/v1/notification-subscriptions')
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
    `TRUNCATE
       notification_event_subscriptions, notification_templates,
       permissions, roles, users,
       buildings, properties, clients
     CASCADE`,
  );

  clientA = await insertRow('clients', { code: 'CLIENTA', name: 'Client A', status: 'ACTIVE' });
  clientB = await insertRow('clients', { code: 'CLIENTB', name: 'Client B', status: 'ACTIVE' });
  const propertyA = await insertRow('properties', { client_id: clientA, code: 'PROPA', name: 'Property A', status: 'ACTIVE' });
  buildingA1 = await insertRow('buildings', { property_id: propertyA, code: 'BLDA1', name: 'Building A1', status: 'ACTIVE' });

  await insertTemplate('WORK_ORDER_ASSIGNED');
  await insertTemplate('FINDING_ESCALATED');

  adminToken = await createAdminUser().then((a) => a.token);
  readOnlyToken = await createSessionWithPermissions([
    { code: 'notification_subscription.read', name: 'Read Notification Subscriptions' },
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

describe('BE-26D notification subscriptions — create', () => {
  it('creates a subscription with the full record (key, eventType, templateKey, rule, context, status)', async () => {
    const response = await createSubscription(adminToken, {
      key: 'work_order_assigned_team',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'work_order_assigned',
      recipientRule: WORK_ORDER_RULE,
      clientId: clientA,
      buildingId: buildingA1,
    });
    assert.equal(response.status, 201);
    const data = response.body.data;

    assert.deepEqual(Object.keys(data).sort(), [
      'buildingId',
      'clientId',
      'createdAt',
      'eventType',
      'id',
      'key',
      'recipientRule',
      'status',
      'templateKey',
      'updatedAt',
    ]);
    assert.equal(data.key, 'WORK_ORDER_ASSIGNED_TEAM', 'key normalized uppercase');
    assert.equal(data.eventType, 'WORK_ORDER_ASSIGNED');
    assert.equal(data.templateKey, 'WORK_ORDER_ASSIGNED');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.clientId, clientA);
    assert.equal(data.buildingId, buildingA1);
    assert.deepEqual(data.recipientRule, {
      specs: [{ kind: 'TEAM', teamId: WORK_ORDER_RULE.specs[0].teamId }],
    });
    assert.ok(!Number.isNaN(Date.parse(data.createdAt)));
  });

  it('rejects a duplicate subscription key (409)', async () => {
    const first = await createSubscription(adminToken, {
      key: 'dup_sub',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    assert.equal(first.status, 201);

    const second = await createSubscription(adminToken, {
      key: 'dup_sub',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'NOTIFICATION_SUBSCRIPTION_KEY_ALREADY_EXISTS');
  });

  it('rejects a missing template reference (400)', async () => {
    const response = await createSubscription(adminToken, {
      key: 'missing_template',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'DOES_NOT_EXIST',
      recipientRule: WORK_ORDER_RULE,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'NOTIFICATION_SUBSCRIPTION_TEMPLATE_NOT_FOUND');
  });

  it('rejects an invalid recipient rule (400, reused BE-26C validation)', async () => {
    const response = await createSubscription(adminToken, {
      key: 'bad_rule',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: { specs: [{ kind: 'NOT_A_KIND' }] },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field.startsWith('recipientRule.'),
      ),
    );
  });

  it('rejects a building that does not belong to the given client (400)', async () => {
    const propertyB = await insertRow('properties', { client_id: clientB, code: 'PROPB', name: 'Property B', status: 'ACTIVE' });
    const buildingB = await insertRow('buildings', { property_id: propertyB, code: 'BLDB', name: 'Building B', status: 'ACTIVE' });

    const response = await createSubscription(adminToken, {
      key: 'mismatched_context',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
      clientId: clientA,
      buildingId: buildingB,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      response.body.error.details.some(
        (detail: { field: string }) => detail.field === 'buildingId',
      ),
    );
  });

  it('requires notification_subscription.manage (read-only user gets 403)', async () => {
    const response = await createSubscription(readOnlyToken, {
      key: 'no_manage',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });
});

describe('BE-26D notification subscriptions — list / get', () => {
  it('lists subscriptions ordered by key and filters by status', async () => {
    await createSubscription(adminToken, {
      key: 'z_list',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    await createSubscription(adminToken, {
      key: 'a_list',
      eventType: 'FINDING_ESCALATED',
      templateKey: 'FINDING_ESCALATED',
      recipientRule: WORK_ORDER_RULE,
    });

    const list = await api()
      .get('/api/v1/notification-subscriptions')
      .set(auth(adminToken));
    assert.equal(list.status, 200);
    const keys = (list.body.data as { key: string }[]).map((item) => item.key);
    assert.ok(keys.indexOf('A_LIST') < keys.indexOf('Z_LIST'), 'ordered by key');

    const active = await api()
      .get('/api/v1/notification-subscriptions?status=ACTIVE')
      .set(auth(adminToken));
    assert.ok(
      (active.body.data as { status: string }[]).every(
        (item) => item.status === 'ACTIVE',
      ),
    );

    const bad = await api()
      .get('/api/v1/notification-subscriptions?status=GONE')
      .set(auth(adminToken));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  });

  it('gets a subscription by id; 404 for missing; 400 for invalid id', async () => {
    const created = await createSubscription(adminToken, {
      key: 'get_me_sub',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    const subId = created.body.data.id as string;

    const got = await api()
      .get(`/api/v1/notification-subscriptions/${subId}`)
      .set(auth(adminToken));
    assert.equal(got.status, 200);
    assert.equal(got.body.data.key, 'GET_ME_SUB');

    const missing = await api()
      .get(`/api/v1/notification-subscriptions/${randomUUID()}`)
      .set(auth(adminToken));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOTIFICATION_SUBSCRIPTION_NOT_FOUND');

    const badId = await api()
      .get('/api/v1/notification-subscriptions/not-a-uuid')
      .set(auth(adminToken));
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires authentication (401)', async () => {
    const anon = await api().get('/api/v1/notification-subscriptions');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});

describe('BE-26D notification subscriptions — update', () => {
  it('updates eventType/template/rule/context and deactivates', async () => {
    const created = await createSubscription(adminToken, {
      key: 'updatable_sub',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    const subId = created.body.data.id as string;

    const updated = await api()
      .patch(`/api/v1/notification-subscriptions/${subId}`)
      .set(auth(adminToken))
      .send({
        eventType: 'FINDING_ESCALATED',
        templateKey: 'FINDING_ESCALATED',
        recipientRule: { specs: [{ kind: 'ROLE', roleCode: 'ENGINEER' }] },
      });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.eventType, 'FINDING_ESCALATED');
    assert.equal(updated.body.data.templateKey, 'FINDING_ESCALATED');
    assert.deepEqual(updated.body.data.recipientRule, {
      specs: [{ kind: 'ROLE', roleCode: 'ENGINEER' }],
    });

    const deactivated = await api()
      .patch(`/api/v1/notification-subscriptions/${subId}`)
      .set(auth(adminToken))
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');
  });

  it('rejects changing the immutable subscription key', async () => {
    const created = await createSubscription(adminToken, {
      key: 'immutable_sub',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    const subId = created.body.data.id as string;

    const response = await api()
      .patch(`/api/v1/notification-subscriptions/${subId}`)
      .set(auth(adminToken))
      .send({ key: 'CHANGED_KEY' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an update pointing at a missing template (400)', async () => {
    const created = await createSubscription(adminToken, {
      key: 'retarget_sub',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    const subId = created.body.data.id as string;

    const response = await api()
      .patch(`/api/v1/notification-subscriptions/${subId}`)
      .set(auth(adminToken))
      .send({ templateKey: 'DOES_NOT_EXIST' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'NOTIFICATION_SUBSCRIPTION_TEMPLATE_NOT_FOUND');
  });
});

describe('BE-26D notification subscriptions — event matching seam', () => {
  it('matches ACTIVE subscriptions for an event type, honoring Client/Building context', async () => {
    // Isolate matching from subscriptions created by earlier describe blocks.
    await q('DELETE FROM notification_event_subscriptions');

    // A second building (under clientB) for cross-scope mismatch assertions.
    const propertyB = await insertRow('properties', { client_id: clientB, code: 'PROPB2', name: 'Property B2', status: 'ACTIVE' });
    const buildingOther = await insertRow('buildings', { property_id: propertyB, code: 'BLDB2', name: 'Building B2', status: 'ACTIVE' });

    // Wildcard subscription (no context).
    await createSubscription(adminToken, {
      key: 'match_wild',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
    });
    // Fully-scoped subscription (clientA + buildingA1).
    await createSubscription(adminToken, {
      key: 'match_ab',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
      clientId: clientA,
      buildingId: buildingA1,
    });
    // Inactive subscription (must never match).
    await createSubscription(adminToken, {
      key: 'match_inactive',
      eventType: 'WORK_ORDER_ASSIGNED',
      templateKey: 'WORK_ORDER_ASSIGNED',
      recipientRule: WORK_ORDER_RULE,
      status: 'INACTIVE',
    });
    // Different event type (must never match).
    await createSubscription(adminToken, {
      key: 'match_other_event',
      eventType: 'FINDING_ESCALATED',
      templateKey: 'FINDING_ESCALATED',
      recipientRule: WORK_ORDER_RULE,
    });

    const keysOf = (subs: { key: string }[]) => subs.map((s) => s.key);

    // No context → every ACTIVE subscription for the event matches.
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED')).sort(),
      ['MATCH_AB', 'MATCH_WILD'].sort(),
    );

    // Matching client context → wildcard + matching client scope.
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED', { clientId: clientA })).sort(),
      ['MATCH_AB', 'MATCH_WILD'].sort(),
    );

    // Unrelated client context → wildcard only (scoped sub excluded).
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED', { clientId: clientB })),
      ['MATCH_WILD'],
    );

    // Matching building context → wildcard + matching building scope.
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED', { buildingId: buildingA1 })).sort(),
      ['MATCH_AB', 'MATCH_WILD'].sort(),
    );

    // Unrelated building context → wildcard only.
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED', { buildingId: buildingOther })),
      ['MATCH_WILD'],
    );

    // Both contexts matching → both subs.
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED', { clientId: clientA, buildingId: buildingA1 })).sort(),
      ['MATCH_AB', 'MATCH_WILD'].sort(),
    );

    // Both contexts, building mismatched → wildcard only.
    assert.deepEqual(
      keysOf(await findMatchingSubscriptions('WORK_ORDER_ASSIGNED', { clientId: clientA, buildingId: buildingOther })),
      ['MATCH_WILD'],
    );

    // Unknown event type → no subscriptions.
    assert.deepEqual(await findMatchingSubscriptions('UNKNOWN_EVENT'), []);
  });
});
