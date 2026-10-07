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
import { clientService } from '../src/modules/clients';
import { entitlementService } from '../src/modules/entitlements';
import { licenseService } from '../src/modules/licenses';
import { moduleConfigurationRepository } from '../src/modules/module-configurations/module-configuration.repository';
import { moduleService } from '../src/modules/modules';
import { propertyService } from '../src/modules/properties';
import { subscriptionService } from '../src/modules/subscriptions';
import { createAdminUser, createPlainSession } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/** BE-27C focused tests only: scoped Module intent and entitlement intersection. */

const DB_PORT = 55456;
const DATA_DIR = '/tmp/asentra-be27c-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
const START = new Date('2026-01-01T00:00:00.000Z');
const END = new Date('2027-12-31T00:00:00.000Z');

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
let clientBId = '';
let buildingBId = '';
let subscriptionAId = '';
let siblingConfigurationId = '';
let clientBConfigurationId = '';

const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const suffix = () => randomUUID().slice(0, 8).toUpperCase();

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('BE-27C test database is unavailable');
    return false;
  }
  return true;
}

async function createModule(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  const code = `MOD_${suffix()}`;
  return moduleService.createModule({ code, name: `Module ${code}`, status });
}

async function createClientWithBuildings(
  assignFirstTo?: string,
  buildingCount = 1,
) {
  const client = await clientService.createClient({
    code: `MCFG_${suffix()}`,
    name: 'Module Configuration Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Module Configuration Property',
  });
  const buildings = [];
  for (let index = 0; index < buildingCount; index += 1) {
    buildings.push(
      await buildingService.createBuilding({
        propertyId: property.id,
        code: `BLDG_${suffix()}`,
        name: `Module Configuration Building ${index + 1}`,
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

async function entitle(moduleId: string) {
  return entitlementService.createEntitlement(subscriptionAId, {
    moduleId,
    startsAt: START,
    endsAt: END,
  });
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
    `TRUNCATE module_configurations, building_configurations,
       client_configurations, module_entitlements, licenses, subscriptions,
       modules, user_building_assignments, buildings, properties, clients,
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
  const subscription = await subscriptionService.createSubscription({
    clientId: clientAId,
    code: `SUB_${suffix()}`,
    planCode: 'ENTERPRISE',
    startsAt: START,
    endsAt: END,
  });
  subscriptionAId = subscription.id;
  await licenseService.createLicense(subscription.id, {
    validFrom: START,
    validUntil: END,
  });

  const siblingModule = await createModule();
  siblingConfigurationId = (
    await moduleConfigurationRepository.create({
      scopeType: 'BUILDING',
      clientId: null,
      buildingId: siblingBuildingId,
      moduleId: siblingModule.id,
      enabled: true,
    })
  ).id;

  const scopeB = await createClientWithBuildings(undefined, 1);
  clientBId = scopeB.client.id;
  buildingBId = scopeB.buildings[0].id;
  const clientBModule = await createModule();
  clientBConfigurationId = (
    await moduleConfigurationRepository.create({
      scopeType: 'CLIENT',
      clientId: clientBId,
      buildingId: null,
      moduleId: clientBModule.id,
      enabled: true,
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

async function createClientConfiguration(moduleKey: string, enabled: boolean) {
  const response = await api()
    .post(`/api/v1/clients/${clientAId}/module-configurations`)
    .set(auth())
    .send({ moduleKey, enabled });
  if (response.status === 201) {
    await activateLatestConfigurationVersion(
      adminToken,
      'MODULE_CONFIGURATION',
      response.body.data.id,
    );
  }
  return response;
}

async function createBuildingConfiguration(moduleKey: string, enabled: boolean) {
  const response = await api()
    .post(`/api/v1/buildings/${buildingAId}/module-configurations`)
    .set(auth())
    .send({ moduleKey, enabled });
  if (response.status === 201) {
    await activateLatestConfigurationVersion(
      adminToken,
      'MODULE_CONFIGURATION',
      response.body.data.id,
    );
  }
  return response;
}

describe('BE-27C Module configuration records', () => {
  it('binds an existing Module key to Client configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const module = await createModule();
    const response = await createClientConfiguration(
      module.code.toLowerCase(),
      true,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.scopeType, 'CLIENT');
    assert.equal(response.body.data.clientId, clientAId);
    assert.equal(response.body.data.buildingId, null);
    assert.equal(response.body.data.moduleId, module.id);
    assert.equal(response.body.data.moduleKey, module.code);
    assert.equal(response.body.data.enabled, true);
  });

  it('binds Building configuration under its derived Client context', async (t) => {
    if (!requireDatabase(t)) return;
    const module = await createModule();
    const response = await createBuildingConfiguration(module.code, false);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.scopeType, 'BUILDING');
    assert.equal(response.body.data.clientId, clientAId);
    assert.equal(response.body.data.buildingId, buildingAId);
    assert.equal(response.body.data.moduleId, module.id);
    assert.equal(response.body.data.enabled, false);
  });

  it('enforces one Module binding per scope while allowing Client/Building override', async (t) => {
    if (!requireDatabase(t)) return;
    const module = await createModule();
    await createClientConfiguration(module.code, true);
    const duplicate = await createClientConfiguration(module.code, false);
    assert.equal(duplicate.status, 409);
    assert.equal(
      duplicate.body.error.code,
      'MODULE_CONFIGURATION_ALREADY_EXISTS',
    );

    const building = await createBuildingConfiguration(module.code, false);
    assert.equal(building.status, 201);
    assert.equal(building.body.data.moduleId, module.id);
  });

  it('lists, gets, and updates enabled/disabled intent', async (t) => {
    if (!requireDatabase(t)) return;
    const first = await createModule();
    const second = await createModule();
    const created = await createClientConfiguration(first.code, true);
    await createClientConfiguration(second.code, false);

    const listed = await api()
      .get(`/api/v1/clients/${clientAId}/module-configurations`)
      .set(auth());
    assert.equal(listed.status, 200);
    const keys = listed.body.data.map((item: { moduleKey: string }) => item.moduleKey);
    assert.deepEqual(keys, [...keys].sort());
    assert.ok(
      listed.body.data.every(
        (item: { scopeType: string; clientId: string }) =>
          item.scopeType === 'CLIENT' && item.clientId === clientAId,
      ),
    );

    const updated = await api()
      .patch(`/api/v1/module-configurations/${created.body.data.id}`)
      .set(auth())
      .send({ enabled: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.enabled, false);

    const one = await api()
      .get(`/api/v1/module-configurations/${created.body.data.id}`)
      .set(auth());
    assert.equal(one.status, 200);
    assert.equal(one.body.data.enabled, false);
  });
});

describe('BE-27C effective Module configuration', () => {
  it('intersects Client intent with existing effective Module Entitlements', async (t) => {
    if (!requireDatabase(t)) return;
    const entitledEnabled = await createModule();
    const entitledDisabled = await createModule();
    const unentitledEnabled = await createModule();
    const entitledUnconfigured = await createModule();
    await entitle(entitledEnabled.id);
    await entitle(entitledDisabled.id);
    await entitle(entitledUnconfigured.id);
    await createClientConfiguration(entitledEnabled.code, true);
    await createClientConfiguration(entitledDisabled.code, false);
    await createClientConfiguration(unentitledEnabled.code, true);

    const effective = await api()
      .get(`/api/v1/clients/${clientAId}/module-configurations/effective`)
      .set(auth());
    assert.equal(effective.status, 200, JSON.stringify(effective.body));
    assert.equal(effective.body.data.clientId, clientAId);
    assert.equal(effective.body.data.buildingId, null);
    const byKey = new Map(
      effective.body.data.modules.map((item: { moduleKey: string }) => [
        item.moduleKey,
        item,
      ]),
    );
    assert.deepEqual(byKey.get(entitledEnabled.code), {
      moduleId: entitledEnabled.id,
      moduleKey: entitledEnabled.code,
      moduleName: entitledEnabled.name,
      configuredEnabled: true,
      entitled: true,
      enabled: true,
      source: 'CLIENT',
    });
    assert.equal(byKey.get(entitledDisabled.code).entitled, true);
    assert.equal(byKey.get(entitledDisabled.code).enabled, false);
    assert.equal(byKey.get(unentitledEnabled.code).entitled, false);
    assert.equal(byKey.get(unentitledEnabled.code).enabled, false);
    assert.equal(byKey.has(entitledUnconfigured.code), false);
  });

  it('applies Building intent over Client intent before entitlement intersection', async (t) => {
    if (!requireDatabase(t)) return;
    const overridden = await createModule();
    const buildingOnly = await createModule();
    await entitle(overridden.id);
    await entitle(buildingOnly.id);
    await createClientConfiguration(overridden.code, true);
    await createBuildingConfiguration(overridden.code, false);
    await createBuildingConfiguration(buildingOnly.code, true);

    const effective = await api()
      .get(`/api/v1/buildings/${buildingAId}/module-configurations/effective`)
      .set(auth());
    assert.equal(effective.status, 200, JSON.stringify(effective.body));
    assert.equal(effective.body.data.clientId, clientAId);
    assert.equal(effective.body.data.buildingId, buildingAId);
    const byKey = new Map(
      effective.body.data.modules.map((item: { moduleKey: string }) => [
        item.moduleKey,
        item,
      ]),
    );
    assert.equal(byKey.get(overridden.code).source, 'BUILDING');
    assert.equal(byKey.get(overridden.code).configuredEnabled, false);
    assert.equal(byKey.get(overridden.code).entitled, true);
    assert.equal(byKey.get(overridden.code).enabled, false);
    assert.equal(byKey.get(buildingOnly.code).source, 'BUILDING');
    assert.equal(byKey.get(buildingOnly.code).enabled, true);
  });
});

describe('BE-27C validation, RBAC, and isolation', () => {
  it('requires an existing ACTIVE Module key and immutable scope/reference', async (t) => {
    if (!requireDatabase(t)) return;
    let response = await createClientConfiguration('UNKNOWN_MODULE', true);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'MODULE_NOT_FOUND');

    const inactive = await createModule('INACTIVE');
    response = await createClientConfiguration(inactive.code, true);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'MODULE_INACTIVE');

    response = await api()
      .post(`/api/v1/clients/${clientAId}/module-configurations`)
      .set(auth())
      .send({ moduleKey: inactive.code, enabled: 'yes' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');

    const module = await createModule();
    const created = await createClientConfiguration(module.code, true);
    const immutable = await api()
      .patch(`/api/v1/module-configurations/${created.body.data.id}`)
      .set(auth())
      .send({ moduleKey: 'CHANGED', enabled: false });
    assert.equal(immutable.status, 400);
    assert.equal(immutable.body.error.code, 'VALIDATION_ERROR');
  });

  it('requires authentication and dedicated permissions', async (t) => {
    if (!requireDatabase(t)) return;
    const unauthenticated = await api().get(
      `/api/v1/clients/${clientAId}/module-configurations`,
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');

    const module = await createModule();
    const forbidden = await api()
      .post(`/api/v1/clients/${clientAId}/module-configurations`)
      .set(auth(plainToken))
      .send({ moduleKey: module.code, enabled: true });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies same-Client sibling and cross-Client scope access', async (t) => {
    if (!requireDatabase(t)) return;
    for (const path of [
      `/api/v1/buildings/${siblingBuildingId}/module-configurations`,
      `/api/v1/buildings/${siblingBuildingId}/module-configurations/effective`,
      `/api/v1/module-configurations/${siblingConfigurationId}`,
      `/api/v1/clients/${clientBId}/module-configurations`,
      `/api/v1/clients/${clientBId}/module-configurations/effective`,
      `/api/v1/buildings/${buildingBId}/module-configurations`,
      `/api/v1/module-configurations/${clientBConfigurationId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }

    const update = await api()
      .patch(`/api/v1/module-configurations/${clientBConfigurationId}`)
      .set(auth())
      .send({ enabled: false });
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-27C OpenAPI contract', () => {
  it('documents Module configuration in the final BE-27 contract', () => {
    const spec = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/clients/{clientId}/module-configurations',
      '/clients/{clientId}/module-configurations/effective',
      '/buildings/{buildingId}/module-configurations',
      '/buildings/{buildingId}/module-configurations/effective',
      '/module-configurations/{moduleConfigurationId}',
    ]) {
      assert.ok(spec.paths[path], `${path} must be documented`);
    }
    for (const schema of [
      'ModuleConfiguration',
      'CreateModuleConfigurationRequest',
      'UpdateModuleConfigurationRequest',
      'EffectiveModuleConfigurationItem',
      'EffectiveModuleConfiguration',
    ]) {
      assert.ok(spec.components.schemas[schema], `${schema} schema required`);
    }
    assert.ok(spec.paths['/clients/{clientId}/feature-entitlements']);
  });
});
