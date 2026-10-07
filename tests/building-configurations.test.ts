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
import { buildingConfigurationRepository } from '../src/modules/building-configurations/building-configuration.repository';
import { buildingService } from '../src/modules/buildings';
import { clientConfigurationRepository } from '../src/modules/client-configurations/client-configuration.repository';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-27B focused tests only: Building records, Client fallback, RBAC and isolation. */

const DB_PORT = 55455;
const DATA_DIR = '/tmp/asentra-be27b-pg';
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
let buildingAId = '';
let siblingBuildingId = '';
let siblingConfigurationId = '';
let clientBId = '';
let buildingBId = '';
let buildingBConfigurationId = '';

const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('BE-27B test database is unavailable');
    return false;
  }
  return true;
}

async function createClientWithBuildings(
  assignFirstTo?: string,
  buildingCount = 1,
) {
  const client = await clientService.createClient({
    code: `BCFG_${suffix()}`,
    name: 'Building Configuration Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Building Configuration Property',
  });
  const buildings = [];
  for (let index = 0; index < buildingCount; index += 1) {
    buildings.push(
      await buildingService.createBuilding({
        propertyId: property.id,
        code: `BLDG_${suffix()}`,
        name: `Configuration Building ${index + 1}`,
      }),
    );
  }
  if (assignFirstTo && buildings[0]) {
    await buildingAssignmentService.createAssignment(assignFirstTo, {
      buildingId: buildings[0].id,
    });
  }
  return { client, property, buildings };
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
    `TRUNCATE building_configurations, client_configurations,
       user_building_assignments, buildings, properties, clients,
       user_sessions, user_credentials, role_permission_assignments,
       user_role_assignments, permissions, roles, users CASCADE`,
  );

  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();

  const scopeA = await createClientWithBuildings(adminUserId, 2);
  clientAId = scopeA.client.id;
  buildingAId = scopeA.buildings[0].id;
  siblingBuildingId = scopeA.buildings[1].id;
  siblingConfigurationId = (
    await buildingConfigurationRepository.create({
      buildingId: siblingBuildingId,
      key: 'SIBLING.PRIVATE',
      value: true,
      status: 'ACTIVE',
    })
  ).id;

  const scopeB = await createClientWithBuildings(undefined, 1);
  clientBId = scopeB.client.id;
  buildingBId = scopeB.buildings[0].id;
  buildingBConfigurationId = (
    await buildingConfigurationRepository.create({
      buildingId: buildingBId,
      key: 'OTHER_CLIENT.PRIVATE',
      value: true,
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
    .post(`/api/v1/buildings/${buildingAId}/configurations`)
    .set(auth())
    .send({ key, value, ...(status ? { status } : {}) });
}

describe('BE-27B Building configuration record', () => {
  it('creates a Building record and derives its Client reference', async (t) => {
    if (!requireDatabase(t)) return;
    const response = await createConfiguration(' building.locale ', {
      locale: 'id-ID',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.clientId, clientAId);
    assert.equal(response.body.data.buildingId, buildingAId);
    assert.equal(response.body.data.key, 'BUILDING.LOCALE');
    assert.deepEqual(response.body.data.value, { locale: 'id-ID' });
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('enforces normalized key uniqueness per Building without global duplication', async (t) => {
    if (!requireDatabase(t)) return;
    await createConfiguration('UNIQUE.BUILDING', 1);
    const duplicate = await createConfiguration('unique.building', 2);
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'BUILDING_CONFIGURATION_KEY_ALREADY_EXISTS',
    );

    const sameKeyElsewhere = await buildingConfigurationRepository.create({
      buildingId: siblingBuildingId,
      key: 'UNIQUE.BUILDING',
      value: 3,
      status: 'ACTIVE',
    });
    assert.equal(sameKeyElsewhere.buildingId, siblingBuildingId);
    assert.equal(sameKeyElsewhere.clientId, clientAId);
  });

  it('lists, filters, gets, and updates Building administration records', async (t) => {
    if (!requireDatabase(t)) return;
    const active = await createConfiguration('ADMIN.ACTIVE', 'before');
    await createConfiguration('ADMIN.INACTIVE', false, 'INACTIVE');

    const listed = await api()
      .get(`/api/v1/buildings/${buildingAId}/configurations?status=ACTIVE`)
      .set(auth());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.every((item: { status: string }) => item.status === 'ACTIVE'));
    assert.ok(
      listed.body.data.every(
        (item: { clientId: string; buildingId: string }) =>
          item.clientId === clientAId && item.buildingId === buildingAId,
      ),
    );

    const updated = await api()
      .patch(`/api/v1/building-configurations/${active.body.data.id}`)
      .set(auth())
      .send({ value: { changed: true } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data.value, { changed: true });

    const one = await api()
      .get(`/api/v1/building-configurations/${active.body.data.id}`)
      .set(auth());
    assert.equal(one.status, 200);
    assert.equal(one.body.data.clientId, clientAId);
  });

  it('resolves Client fallback and ACTIVE Building override by key', async (t) => {
    if (!requireDatabase(t)) return;
    await clientConfigurationRepository.create({
      clientId: clientAId,
      key: 'INHERITED.ONLY',
      value: 'client-only',
      status: 'ACTIVE',
    });
    await clientConfigurationRepository.create({
      clientId: clientAId,
      key: 'OVERRIDDEN.VALUE',
      value: 'client',
      status: 'ACTIVE',
    });
    await clientConfigurationRepository.create({
      clientId: clientAId,
      key: 'INACTIVE.CLIENT',
      value: 'hidden',
      status: 'INACTIVE',
    });
    const buildingOverride = await createConfiguration(
      'OVERRIDDEN.VALUE',
      'building',
    );
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      buildingOverride.body.data.id,
    );
    await createConfiguration('INACTIVE.BUILDING', 'hidden', 'INACTIVE');
    await clientConfigurationRepository.create({
      clientId: clientAId,
      key: 'INACTIVE.BUILDING',
      value: 'client-fallback',
      status: 'ACTIVE',
    });

    const effective = await api()
      .get(`/api/v1/buildings/${buildingAId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.status, 200, JSON.stringify(effective.body));
    assert.equal(effective.body.data.clientId, clientAId);
    assert.equal(effective.body.data.buildingId, buildingAId);
    assert.equal(
      effective.body.data.configurations['INHERITED.ONLY'],
      'client-only',
    );
    assert.equal(
      effective.body.data.configurations['OVERRIDDEN.VALUE'],
      'building',
    );
    assert.equal(
      effective.body.data.configurations['INACTIVE.BUILDING'],
      'client-fallback',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        effective.body.data.configurations,
        'INACTIVE.CLIENT',
      ),
      false,
    );
  });

  it('reuses BE-27A validation and keeps Building/Client/key immutable', async (t) => {
    if (!requireDatabase(t)) return;
    let response = await createConfiguration('invalid key!', true);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');

    response = await api()
      .post(`/api/v1/buildings/${buildingAId}/configurations`)
      .set(auth())
      .send({ key: 'CLIENT.INJECTION', value: true, clientId: clientBId });
    assert.equal(response.status, 400);

    const created = await createConfiguration('IMMUTABLE.BUILDING', true);
    const immutable = await api()
      .patch(`/api/v1/building-configurations/${created.body.data.id}`)
      .set(auth())
      .send({ buildingId: siblingBuildingId, value: false });
    assert.equal(immutable.status, 400);
    assert.equal(immutable.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('BE-27B RBAC and Building isolation', () => {
  it('requires authentication and dedicated permissions', async (t) => {
    if (!requireDatabase(t)) return;
    const unauthenticated = await api().get(
      `/api/v1/buildings/${buildingAId}/configurations`,
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const forbidden = await api()
      .post(`/api/v1/buildings/${buildingAId}/configurations`)
      .set(auth(plainToken))
      .send({ key: 'DENIED', value: true });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies same-Client sibling and cross-Client Building access', async (t) => {
    if (!requireDatabase(t)) return;
    for (const path of [
      `/api/v1/buildings/${siblingBuildingId}/configurations`,
      `/api/v1/buildings/${siblingBuildingId}/configurations/effective`,
      `/api/v1/building-configurations/${siblingConfigurationId}`,
      `/api/v1/buildings/${buildingBId}/configurations`,
      `/api/v1/buildings/${buildingBId}/configurations/effective`,
      `/api/v1/building-configurations/${buildingBConfigurationId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }

    const update = await api()
      .patch(`/api/v1/building-configurations/${buildingBConfigurationId}`)
      .set(auth())
      .send({ value: 'leaked' });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-27B OpenAPI contract', () => {
  it('documents Building configuration in the final BE-27 contract', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/buildings/{buildingId}/configurations',
      '/buildings/{buildingId}/configurations/effective',
      '/building-configurations/{buildingConfigurationId}',
    ]) {
      assert.ok(spec.paths[path], `${path} must be documented`);
    }
    for (const schema of [
      'BuildingConfiguration',
      'CreateBuildingConfigurationRequest',
      'UpdateBuildingConfigurationRequest',
      'EffectiveBuildingConfiguration',
    ]) {
      assert.ok(spec.components.schemas[schema], `${schema} schema required`);
    }
    assert.ok(spec.paths['/clients/{clientId}/module-configurations']);
  });
});
