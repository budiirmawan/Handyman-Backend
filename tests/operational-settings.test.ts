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

const PORT = 55463;
const DIR = '/tmp/asentra-be27j-pg';
const EMBEDDED = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
if (EMBEDDED) {
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = String(PORT);
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
let clientId = '';
let buildingId = '';
let siblingBuildingId = '';
let effectiveClientId = '';
let effectiveBuildingId = '';
let otherClientId = '';
let otherBuildingId = '';
let siblingSettingId = '';
let otherSettingId = '';
let clientSettingId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27J database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string, buildingCount = 1) {
  const client = await clientService.createClient({
    code: `OS_${suffix()}`,
    name: 'Operational Settings Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildings = [];
  for (let index = 0; index < buildingCount; index += 1) {
    buildings.push(
      await buildingService.createBuilding({
        propertyId: property.id,
        code: `B_${suffix()}`,
        name: `Building ${index}`,
        timezone: 'Asia/Jakarta',
      }),
    );
  }
  if (userId) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: buildings[0].id,
    });
  }
  return { client, buildings };
}

before(async () => {
  if (EMBEDDED) {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: DIR,
      port: PORT,
      user: 'postgres',
      password: '',
      persistent: true,
      authMethod: 'trust',
    });
    await postgres.initialise();
    await postgres.start();
    const setup = postgres.getPgClient('postgres', '127.0.0.1');
    await setup.connect();
    await setup.query('CREATE DATABASE asentra_test');
    await setup.end();
  }
  const config = await ensureTestDatabase();
  if (!config) return;
  database = config;
  pool = await initDatabase(config);
  await migrateUp(pool);
  await pool.query(`
    TRUNCATE building_configurations,client_configurations,schedule_recurrence,
      schedule_definitions,user_building_assignments,buildings,properties,clients,
      user_sessions,user_credentials,role_permission_assignments,
      user_role_assignments,permissions,roles,users CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();

  const primary = await createScope(adminUserId, 2);
  clientId = primary.client.id;
  buildingId = primary.buildings[0].id;
  siblingBuildingId = primary.buildings[1].id;

  const effective = await createScope(adminUserId);
  effectiveClientId = effective.client.id;
  effectiveBuildingId = effective.buildings[0].id;

  const other = await createScope();
  otherClientId = other.client.id;
  otherBuildingId = other.buildings[0].id;

  siblingSettingId = (
    await buildingConfigurationRepository.create({
      buildingId: siblingBuildingId,
      key: 'OPERATIONAL.SCHEDULE.DEFAULT_TIMEZONE',
      value: { enabled: true, settingValue: 'Asia/Jayapura' },
      status: 'ACTIVE',
    })
  ).id;
  otherSettingId = (
    await clientConfigurationRepository.create({
      clientId: otherClientId,
      key: 'OPERATIONAL.SCHEDULE.DEFAULT_TIMEZONE',
      value: { enabled: true, settingValue: 'Asia/Jayapura' },
      status: 'ACTIVE',
    })
  ).id;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  pool = null;
  postgres = null;
  database = null;
});

describe('BE-27J Operational Settings', () => {
  it('creates, lists, gets, and updates typed Client settings via BE-27A', async (context) => {
    if (!ready(context)) return;
    const created = await api()
      .post(`/api/v1/clients/${clientId}/operational-settings`)
      .set(auth())
      .send({
        key: 'schedule.default_timezone',
        value: 'Asia/Jakarta',
        enabled: true,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    clientSettingId = created.body.data.id;
    assert.equal(created.body.data.key, 'SCHEDULE.DEFAULT_TIMEZONE');
    assert.equal(created.body.data.scopeType, 'CLIENT');
    assert.equal(created.body.data.buildingId, null);

    const stored = (
      await pool!.query(
        'SELECT key,value,status FROM client_configurations WHERE id=$1',
        [clientSettingId],
      )
    ).rows[0];
    assert.equal(stored.key, 'OPERATIONAL.SCHEDULE.DEFAULT_TIMEZONE');
    assert.deepEqual(stored.value, {
      enabled: true,
      settingValue: 'Asia/Jakarta',
    });

    const list = await api()
      .get(`/api/v1/clients/${clientId}/operational-settings`)
      .set(auth());
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    const get = await api()
      .get(`/api/v1/client-operational-settings/${clientSettingId}`)
      .set(auth());
    assert.equal(get.status, 200);

    const updated = await api()
      .patch(`/api/v1/client-operational-settings/${clientSettingId}`)
      .set(auth())
      .send({ value: 'Asia/Pontianak', enabled: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.value, 'Asia/Pontianak');
    assert.equal(updated.body.data.enabled, false);

    const restored = await api()
      .patch(`/api/v1/client-operational-settings/${clientSettingId}`)
      .set(auth())
      .send({ value: 'Asia/Jakarta', enabled: true });
    assert.equal(restored.status, 200);
  });

  it('uses BE-27B override/fallback semantics for effective Building settings', async (context) => {
    if (!ready(context)) return;
    const client = await api()
      .post(`/api/v1/clients/${effectiveClientId}/operational-settings`)
      .set(auth())
      .send({ key: 'SCHEDULE.DEFAULT_TIMEZONE', value: 'Asia/Jakarta' });
    assert.equal(client.status, 201, JSON.stringify(client.body));
    await activateLatestConfigurationVersion(
      adminToken,
      'CLIENT_CONFIGURATION',
      client.body.data.id,
    );
    const building = await api()
      .post(`/api/v1/buildings/${effectiveBuildingId}/operational-settings`)
      .set(auth())
      .send({
        key: 'SCHEDULE.DEFAULT_TIMEZONE',
        value: 'Asia/Makassar',
        enabled: false,
      });
    assert.equal(building.status, 201, JSON.stringify(building.body));
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      building.body.data.id,
    );
    assert.equal(building.body.data.clientId, effectiveClientId);
    assert.equal(building.body.data.buildingId, effectiveBuildingId);

    let effective = await api()
      .get(`/api/v1/buildings/${effectiveBuildingId}/operational-settings/effective`)
      .set(auth());
    assert.equal(effective.status, 200);
    assert.equal(effective.body.data.settings[0].value, 'Asia/Makassar');
    assert.equal(effective.body.data.settings[0].enabled, false);

    const inactive = await api()
      .patch(`/api/v1/building-operational-settings/${building.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(inactive.status, 200);
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      building.body.data.id,
    );
    effective = await api()
      .get(`/api/v1/buildings/${effectiveBuildingId}/operational-settings/effective`)
      .set(auth());
    assert.equal(effective.body.data.settings[0].value, 'Asia/Jakarta');
    assert.equal(effective.body.data.settings[0].enabled, true);

    await api()
      .patch(`/api/v1/client-operational-settings/${client.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    await activateLatestConfigurationVersion(
      adminToken,
      'CLIENT_CONFIGURATION',
      client.body.data.id,
    );
    effective = await api()
      .get(`/api/v1/buildings/${effectiveBuildingId}/operational-settings/effective`)
      .set(auth());
    assert.deepEqual(effective.body.data.settings, []);
  });

  it('allowlists and validates settings without bypassing domain workflows', async (context) => {
    if (!ready(context)) return;
    let response = await api()
      .post(`/api/v1/clients/${clientId}/operational-settings`)
      .set(auth())
      .send({ key: 'WORKFLOW.AUTO_APPROVE', value: true });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'OPERATIONAL_SETTING_KEY_NOT_ALLOWED');

    response = await api()
      .post(`/api/v1/clients/${otherClientId}/operational-settings`)
      .set(auth())
      .send({ key: 'SCHEDULE.DEFAULT_TIMEZONE', value: 'not-a-timezone' });
    assert.equal(response.status, 400);

    response = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({
        key: 'OPERATIONAL.SCHEDULE.DEFAULT_TIMEZONE',
        value: 'UTC',
      });
    assert.equal(response.status, 400);

    response = await api()
      .get(`/api/v1/clients/${clientId}/configurations`)
      .set(auth());
    assert.equal(response.status, 200);
    assert.equal(
      response.body.data.some((entry: any) =>
        entry.key.startsWith('OPERATIONAL.'),
      ),
      false,
    );
    assert.equal(
      (
        await api()
          .get(`/api/v1/client-configurations/${clientSettingId}`)
          .set(auth())
      ).status,
      404,
    );
    assert.equal(
      (
        await api()
          .patch(`/api/v1/client-configurations/${clientSettingId}`)
          .set(auth())
          .send({ value: { bypass: true } })
      ).status,
      404,
    );
    response = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(
      response.body.data.configurations[
        'OPERATIONAL.SCHEDULE.DEFAULT_TIMEZONE'
      ],
      undefined,
    );

    const beforeCount = Number(
      (await pool!.query('SELECT COUNT(*)::int AS count FROM schedule_definitions'))
        .rows[0].count,
    );
    response = await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: randomUUID(),
        code: 'NO_DEFAULT_BYPASS',
        name: 'No default bypass',
        startAt: new Date().toISOString(),
      });
    assert.equal(response.status, 400);
    const afterCount = Number(
      (await pool!.query('SELECT COUNT(*)::int AS count FROM schedule_definitions'))
        .rows[0].count,
    );
    assert.equal(afterCount, beforeCount);
  });
});

describe('BE-27J RBAC and isolation', () => {
  it('reuses configuration permissions and Client/Building Data Scope', async (context) => {
    if (!ready(context)) return;
    assert.equal(
      (
        await api().get(
          `/api/v1/clients/${clientId}/operational-settings/effective`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await api()
          .post(`/api/v1/clients/${clientId}/operational-settings`)
          .set(auth(plainToken))
          .send({ key: 'SCHEDULE.DEFAULT_TIMEZONE', value: 'UTC' })
      ).status,
      403,
    );
    for (const path of [
      `/api/v1/buildings/${siblingBuildingId}/operational-settings`,
      `/api/v1/buildings/${otherBuildingId}/operational-settings/effective`,
      `/api/v1/clients/${otherClientId}/operational-settings`,
      `/api/v1/building-operational-settings/${siblingSettingId}`,
      `/api/v1/client-operational-settings/${otherSettingId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
  });
});

describe('BE-27J OpenAPI', () => {
  it('documents Operational Settings in the final BE-27 contract', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/clients/{clientId}/operational-settings',
      '/clients/{clientId}/operational-settings/effective',
      '/client-operational-settings/{operationalSettingId}',
      '/buildings/{buildingId}/operational-settings',
      '/buildings/{buildingId}/operational-settings/effective',
      '/building-operational-settings/{operationalSettingId}',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const name of [
      'OperationalSetting',
      'OperationalSettingKey',
      'CreateOperationalSettingRequest',
      'UpdateOperationalSettingRequest',
      'EffectiveOperationalSettings',
    ]) {
      assert.ok(spec.components.schemas[name], name);
    }
    assert.ok(spec.paths['/clients/{clientId}/organization-presentation']);

    const refs: string[] = [];
    (function walk(value: any): void {
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
        refs.push(value.$ref);
      }
      for (const child of Object.values(value)) walk(child);
    })(spec);
    for (const ref of refs) {
      let value: any = spec;
      for (const part of ref.slice(2).split('/')) {
        value = value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      assert.notEqual(value, undefined, ref);
    }
  });
});
