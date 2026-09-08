import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { parse } from 'yaml';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientConfigurationRepository } from '../src/modules/client-configurations/client-configuration.repository';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-27A focused tests only: Client key/value/status, effective read, RBAC and isolation. */

const DB_PORT = 55454;
const DATA_DIR = '/tmp/asentra-be27a-pg';
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

let postgres: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';
let plainToken = '';
let clientAId = '';
let clientBId = '';
let clientBConfigurationId = '';

const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

async function createClientScope(assignUserId?: string) {
  const client = await clientService.createClient({
    code: `CFG_${suffix()}`,
    name: 'Configuration Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Configuration Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Configuration Building',
  });
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }
  return { client, property, building };
}

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('BE-27A test database is unavailable');
    return false;
  }
  return true;
}

before(async () => {
  if (EMBEDDED_DATABASE) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: DB_PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const admin = postgres.getPgClient('postgres', '127.0.0.1');
    await admin.connect();
    await admin.query('CREATE DATABASE asentra_test');
    await admin.end();
  }

  const db = await ensureTestDatabase();
  if (!db) return;
  database = db;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE client_configurations, user_building_assignments, buildings,
       properties, clients, user_sessions, user_credentials,
       role_permission_assignments, user_role_assignments, permissions, roles,
       users CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();

  clientAId = (await createClientScope(adminUserId)).client.id;
  clientBId = (await createClientScope()).client.id;
  clientBConfigurationId = (
    await clientConfigurationRepository.create({
      clientId: clientBId,
      key: 'PRIVATE_SETTING',
      value: 'not-visible',
      status: 'ACTIVE',
    })
  ).id;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

function createConfiguration(
  key: string,
  value: unknown,
  status?: 'ACTIVE' | 'INACTIVE',
) {
  return api()
    .post(`/api/v1/clients/${clientAId}/configurations`)
    .set(auth())
    .send({ key, value, ...(status ? { status } : {}) });
}

describe('BE-27A Client configuration record', () => {
  it('creates a Client-referenced key/value record with normalized key and ACTIVE default', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await createConfiguration(' default.locale ', {
      locale: 'id-ID',
      fallbacks: ['en-US'],
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.clientId, clientAId);
    assert.equal(response.body.data.key, 'DEFAULT.LOCALE');
    assert.deepEqual(response.body.data.value, {
      locale: 'id-ID',
      fallbacks: ['en-US'],
    });
    assert.equal(response.body.data.status, 'ACTIVE');
    assert.match(response.body.data.id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof response.body.data.createdAt, 'string');
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.meta, {});
  });

  it('enforces one normalized key per Client', async (t) => {
    if (!requireDatabase(t)) return;
    await createConfiguration('UNIQUE.KEY', true);
    const duplicate = await createConfiguration('unique.key', false);
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'CLIENT_CONFIGURATION_KEY_ALREADY_EXISTS',
    );
  });

  it('lists administration records, filters status, and gets one record', async (t) => {
    if (!requireDatabase(t)) return;
    const active = await createConfiguration('LIST.ACTIVE', 1);
    await createConfiguration('LIST.INACTIVE', 2, 'INACTIVE');

    const listed = await api()
      .get(`/api/v1/clients/${clientAId}/configurations?status=ACTIVE`)
      .set(auth());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.length >= 1);
    assert.ok(listed.body.data.every((item: { status: string }) => item.status === 'ACTIVE'));
    const keys = listed.body.data.map((item: { key: string }) => item.key);
    assert.deepEqual(keys, [...keys].sort());

    const one = await api()
      .get(`/api/v1/client-configurations/${active.body.data.id}`)
      .set(auth());
    assert.equal(one.status, 200);
    assert.equal(one.body.data.key, 'LIST.ACTIVE');
  });

  it('updates only value/status and effective read returns ACTIVE key/value data', async (t) => {
    if (!requireDatabase(t)) return;
    const visible = await createConfiguration('EFFECTIVE.VISIBLE', 'before');
    await createConfiguration('EFFECTIVE.HIDDEN', 'secret', 'INACTIVE');

    const updated = await api()
      .patch(`/api/v1/client-configurations/${visible.body.data.id}`)
      .set(auth())
      .send({ value: { enabled: true, threshold: 3 } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data.value, { enabled: true, threshold: 3 });
    await activateLatestConfigurationVersion(
      adminToken,
      'CLIENT_CONFIGURATION',
      visible.body.data.id,
    );

    const effective = await api()
      .get(`/api/v1/clients/${clientAId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.status, 200);
    assert.equal(effective.body.data.clientId, clientAId);
    assert.deepEqual(effective.body.data.configurations['EFFECTIVE.VISIBLE'], {
      enabled: true,
      threshold: 3,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        effective.body.data.configurations,
        'EFFECTIVE.HIDDEN',
      ),
      false,
    );

    const deactivated = await api()
      .patch(`/api/v1/client-configurations/${visible.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    await activateLatestConfigurationVersion(
      adminToken,
      'CLIENT_CONFIGURATION',
      visible.body.data.id,
    );
    const after = await api()
      .get(`/api/v1/clients/${clientAId}/configurations/effective`)
      .set(auth());
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        after.body.data.configurations,
        'EFFECTIVE.VISIBLE',
      ),
      false,
    );
  });

  it('validates key/value/status and keeps Client/key immutable', async (t) => {
    if (!requireDatabase(t)) return;
    let response = await createConfiguration('invalid key!', true);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');

    response = await api()
      .post(`/api/v1/clients/${clientAId}/configurations`)
      .set(auth())
      .send({ key: 'MISSING.VALUE' });
    assert.equal(response.status, 400);

    const invalidStatus = await api()
      .post(`/api/v1/clients/${clientAId}/configurations`)
      .set(auth())
      .send({ key: 'INVALID.STATUS', value: true, status: 'PUBLISHED' });
    assert.equal(invalidStatus.status, 400);

    response = await createConfiguration('IMMUTABLE.KEY', true, 'INACTIVE');
    const id = response.body.data.id;
    const immutable = await api()
      .patch(`/api/v1/client-configurations/${id}`)
      .set(auth())
      .send({ key: 'CHANGED', value: false });
    assert.equal(immutable.status, 400);
    assert.equal(immutable.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-27A RBAC and Client isolation', () => {
  it('requires authentication and dedicated permissions', async (t) => {
    if (!requireDatabase(t)) return;
    const unauthenticated = await api().get(
      `/api/v1/clients/${clientAId}/configurations`,
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await api()
      .post(`/api/v1/clients/${clientAId}/configurations`)
      .set(auth(plainToken))
      .send({ key: 'DENIED', value: true });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies nested, effective, item read, and item update across Clients', async (t) => {
    if (!requireDatabase(t)) return;
    for (const path of [
      `/api/v1/clients/${clientBId}/configurations`,
      `/api/v1/clients/${clientBId}/configurations/effective`,
      `/api/v1/client-configurations/${clientBConfigurationId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }

    const update = await api()
      .patch(`/api/v1/client-configurations/${clientBConfigurationId}`)
      .set(auth())
      .send({ value: 'leaked' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-27A OpenAPI contract', () => {
  it('documents Client configuration in the final BE-27 contract', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/clients/{clientId}/configurations',
      '/clients/{clientId}/configurations/effective',
      '/client-configurations/{clientConfigurationId}',
    ]) {
      assert.ok(spec.paths[path], `${path} must be documented`);
    }
    for (const schema of [
      'ClientConfiguration',
      'ClientConfigurationStatus',
      'CreateClientConfigurationRequest',
      'UpdateClientConfigurationRequest',
      'EffectiveClientConfiguration',
    ]) {
      assert.ok(spec.components.schemas[schema], `${schema} schema required`);
    }
    assert.ok(spec.paths['/buildings/{buildingId}/configurations']);
  });
});
