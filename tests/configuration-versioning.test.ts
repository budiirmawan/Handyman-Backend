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
import { captureConfigurationVersion } from '../src/modules/configuration-versions';
import { clientService } from '../src/modules/clients';
import { moduleService } from '../src/modules/modules';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55467;
const DIR = '/tmp/asentra-be27n-pg';
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
let otherClientId = '';
let otherBuildingId = '';
let otherVersionId = '';
let clientConfigurationId = '';
let firstVersionId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27N database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string) {
  const client = await clientService.createClient({
    code: `CV_${suffix()}`,
    name: 'Configuration Version Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  if (userId) {
    await buildingAssignmentService.createAssignment(userId, {
      buildingId: building.id,
    });
  }
  return { client, building };
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
    TRUNCATE configuration_versions,cms_content,dashboard_widgets,dashboards,
      workspaces,navigation_items,feature_entitlement_configurations,
      module_configurations,building_configurations,client_configurations,
      module_entitlements,modules,user_building_assignments,buildings,properties,
      clients,user_sessions,user_credentials,role_permission_assignments,
      user_role_assignments,permissions,roles,users CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();
  const primary = await createScope(adminUserId);
  clientId = primary.client.id;
  buildingId = primary.building.id;
  const other = await createScope();
  otherClientId = other.client.id;
  otherBuildingId = other.building.id;

  const inaccessible = await captureConfigurationVersion(
    {
      sourceType: 'CLIENT_CONFIGURATION',
      sourceConfigurationId: randomUUID(),
      clientId: otherClientId,
      buildingId: null,
      status: 'ACTIVE',
      snapshot: { key: 'OTHER', value: true },
    },
    adminUserId,
  );
  otherVersionId = inaccessible.id;
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

describe('BE-27N Configuration Versioning', () => {
  it('automatically captures monotonic Client configuration snapshots', async (context) => {
    if (!ready(context)) return;
    const created = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({ key: 'GENERAL.TIMEZONE', value: 'Asia/Jakarta' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    clientConfigurationId = created.body.data.id;

    let versions = await api()
      .get(
        `/api/v1/configuration-sources/CLIENT_CONFIGURATION/${clientConfigurationId}/versions`,
      )
      .set(auth());
    assert.equal(versions.status, 200, JSON.stringify(versions.body));
    assert.equal(versions.body.data.length, 1);
    firstVersionId = versions.body.data[0].id;
    assert.equal(versions.body.data[0].versionNumber, 1);
    assert.equal(versions.body.data[0].previousVersionId, null);
    assert.equal(versions.body.data[0].createdByUserId, adminUserId);
    assert.equal(versions.body.data[0].status, 'ACTIVE');
    assert.equal(versions.body.data[0].snapshot.value, 'Asia/Jakarta');

    const updated = await api()
      .patch(`/api/v1/client-configurations/${clientConfigurationId}`)
      .set(auth())
      .send({ value: 'Asia/Makassar', status: 'INACTIVE' });
    assert.equal(updated.status, 200);
    versions = await api()
      .get(
        `/api/v1/configuration-sources/CLIENT_CONFIGURATION/${clientConfigurationId}/versions`,
      )
      .set(auth());
    assert.equal(versions.body.data.length, 2);
    assert.equal(versions.body.data[1].versionNumber, 2);
    assert.equal(versions.body.data[1].previousVersionId, firstVersionId);
    assert.equal(versions.body.data[1].status, 'INACTIVE');
    assert.equal(versions.body.data[1].snapshot.value, 'Asia/Makassar');
    assert.equal(versions.body.data[0].snapshot.value, 'Asia/Jakarta');

    const one = await api()
      .get(`/api/v1/configuration-versions/${firstVersionId}`)
      .set(auth());
    assert.equal(one.status, 200);
    assert.equal(one.body.data.versionNumber, 1);
  });

  it('enforces immutable version rows at the database boundary', async (context) => {
    if (!ready(context)) return;
    await assert.rejects(
      pool!.query(
        `UPDATE configuration_versions SET snapshot='{}'::jsonb WHERE id=$1`,
        [firstVersionId],
      ),
      (error: any) => error.code === '55000',
    );
    await assert.rejects(
      pool!.query('DELETE FROM configuration_versions WHERE id=$1', [firstVersionId]),
      (error: any) => error.code === '55000',
    );
    const original = (
      await pool!.query(
        'SELECT snapshot,version_number FROM configuration_versions WHERE id=$1',
        [firstVersionId],
      )
    ).rows[0];
    assert.equal(original.snapshot.value, 'Asia/Jakarta');
    assert.equal(original.version_number, 1);
  });

  it('preserves Building scope and versions suitable BE-27 domains', async (context) => {
    if (!ready(context)) return;
    const building = await api()
      .post(`/api/v1/buildings/${buildingId}/configurations`)
      .set(auth())
      .send({ key: 'BUILDING.MODE', value: 'SITE' });
    assert.equal(building.status, 201);
    let versions = await api()
      .get(
        `/api/v1/configuration-sources/BUILDING_CONFIGURATION/${building.body.data.id}/versions`,
      )
      .set(auth());
    assert.equal(versions.status, 200);
    assert.equal(versions.body.data[0].clientId, clientId);
    assert.equal(versions.body.data[0].buildingId, buildingId);

    const module = await moduleService.createModule({
      code: `VERSION_${suffix()}`,
      name: 'Versioned Module',
    });
    const moduleConfiguration = await api()
      .post(`/api/v1/clients/${clientId}/module-configurations`)
      .set(auth())
      .send({ moduleKey: module.code, enabled: true });
    assert.equal(moduleConfiguration.status, 201, JSON.stringify(moduleConfiguration.body));
    versions = await api()
      .get(
        `/api/v1/configuration-sources/MODULE_CONFIGURATION/${moduleConfiguration.body.data.id}/versions`,
      )
      .set(auth());
    assert.equal(versions.status, 200);
    assert.equal(versions.body.data[0].status, 'ENABLED');

    const cms = await api()
      .post(`/api/v1/clients/${clientId}/cms-content`)
      .set(auth())
      .send({
        contentType: 'HELP',
        slug: 'versioned-help',
        title: 'Versioned Help',
        body: 'Safe content.',
      });
    assert.equal(cms.status, 201);
    versions = await api()
      .get(
        `/api/v1/configuration-sources/CMS_CONTENT/${cms.body.data.id}/versions`,
      )
      .set(auth());
    assert.equal(versions.status, 200);
    assert.equal(versions.body.data[0].status, 'DRAFT');
    assert.equal(versions.body.data[0].snapshot.slug, 'versioned-help');
  });
});

describe('BE-27N RBAC and isolation', () => {
  it('uses source-domain permission and existing Client/Building Data Scope', async (context) => {
    if (!ready(context)) return;
    const path = `/api/v1/configuration-sources/CLIENT_CONFIGURATION/${clientConfigurationId}/versions`;
    assert.equal((await api().get(path)).status, 401);
    assert.equal((await api().get(path).set(auth(plainToken))).status, 403);
    const inaccessible = await api()
      .get(`/api/v1/configuration-versions/${otherVersionId}`)
      .set(auth());
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');

    const otherBuildingVersion = await captureConfigurationVersion(
      {
        sourceType: 'BUILDING_CONFIGURATION',
        sourceConfigurationId: randomUUID(),
        clientId: otherClientId,
        buildingId: otherBuildingId,
        status: 'ACTIVE',
        snapshot: { key: 'OTHER.BUILDING' },
      },
      adminUserId,
    );
    assert.equal(
      (
        await api()
          .get(`/api/v1/configuration-versions/${otherBuildingVersion.id}`)
          .set(auth())
      ).status,
      403,
    );
  });
});

describe('BE-27N OpenAPI', () => {
  it('documents immutable history and the final lifecycle contract', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/configuration-sources/{sourceType}/{sourceConfigurationId}/versions',
      '/configuration-versions/{configurationVersionId}',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const schema of [
      'ConfigurationVersionSourceType',
      'ConfigurationVersion',
    ]) {
      assert.ok(spec.components.schemas[schema], schema);
    }
    assert.ok(
      spec.paths['/configuration-versions/{configurationVersionId}/validate'],
    );
    assert.ok(
      spec.paths['/configuration-versions/{configurationVersionId}/publish'],
    );

    const refs: string[] = [];
    (function walk(value: any): void {
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) refs.push(value.$ref);
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
