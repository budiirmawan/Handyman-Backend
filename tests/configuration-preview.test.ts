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
import { captureConfigurationVersion } from '../src/modules/configuration-versions';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55469;
const DIR = '/tmp/asentra-be27p-pg';
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
let otherVersionId = '';
let activeVersionId = '';
let previewVersionId = '';
let previewContextId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27P database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string) {
  const client = await clientService.createClient({
    code: `PV_${suffix()}`,
    name: 'Preview Client',
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

async function listVersions(sourceType: string, sourceId: string) {
  return api()
    .get(`/api/v1/configuration-sources/${sourceType}/${sourceId}/versions`)
    .set(auth());
}

async function action(id: string, operation: 'validate' | 'publish' | 'activate') {
  return api()
    .post(`/api/v1/configuration-versions/${id}/${operation}`)
    .set(auth())
    .send({});
}

async function activateVersion(id: string) {
  assert.equal((await action(id, 'validate')).status, 200);
  assert.equal((await action(id, 'publish')).status, 200);
  assert.equal((await action(id, 'activate')).status, 200);
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
    TRUNCATE configuration_preview_contexts,configuration_version_transitions,
      configuration_version_validations,configuration_versions,workspaces,
      navigation_items,feature_entitlement_configurations,module_configurations,
      building_configurations,client_configurations,user_building_assignments,
      buildings,properties,clients,user_sessions,user_credentials,
      role_permission_assignments,user_role_assignments,permissions,roles,users
      CASCADE
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
  const otherSource = await clientConfigurationRepository.create({
    clientId: otherClientId,
    key: 'PREVIEW.OTHER',
    value: 'other',
    status: 'ACTIVE',
  });
  const otherVersion = await captureConfigurationVersion(
    {
      sourceType: 'CLIENT_CONFIGURATION',
      sourceConfigurationId: otherSource.id,
      clientId: otherClientId,
      buildingId: null,
      status: 'ACTIVE',
      snapshot: {
        id: otherSource.id,
        clientId: otherClientId,
        key: otherSource.key,
        value: otherSource.value,
        status: otherSource.status,
      },
    },
    adminUserId,
  );
  otherVersionId = otherVersion.id;
  await pool.query(
    `UPDATE configuration_versions SET lifecycle_status='VALIDATED' WHERE id=$1`,
    [otherVersionId],
  );
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

describe('BE-27P Preview Context', () => {
  it('previews validated configuration without changing ACTIVE context', async (context) => {
    if (!ready(context)) return;
    const source = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({ key: 'PREVIEW.FLAG', value: 'active-value' });
    let history = await listVersions('CLIENT_CONFIGURATION', source.body.data.id);
    activeVersionId = history.body.data[0].id;
    await activateVersion(activeVersionId);

    await api()
      .patch(`/api/v1/client-configurations/${source.body.data.id}`)
      .set(auth())
      .send({ value: 'preview-value' });
    history = await listVersions('CLIENT_CONFIGURATION', source.body.data.id);
    previewVersionId = history.body.data[1].id;
    const validated = await action(previewVersionId, 'validate');
    assert.equal(validated.body.data.version.lifecycleStatus, 'VALIDATED');

    const created = await api()
      .post(`/api/v1/configuration-versions/${previewVersionId}/preview-contexts`)
      .set(auth())
      .send({ expiresInMinutes: 30 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    previewContextId = created.body.data.id;
    assert.equal(created.body.data.mode, 'PREVIEW');
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.clientId, clientId);
    assert.equal(created.body.data.buildingId, null);

    const active = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(active.body.data.configurations['PREVIEW.FLAG'], 'active-value');

    const preview = await api()
      .get(`/api/v1/configuration-preview-contexts/${previewContextId}/effective`)
      .set(auth());
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.mode, 'PREVIEW');
    assert.equal(preview.body.data.version.lifecycleStatus, 'VALIDATED');
    assert.equal(
      preview.body.data.configuration.configurations['PREVIEW.FLAG'],
      'preview-value',
    );
    assert.equal(preview.body.data.navigation, null);
    assert.equal(preview.body.data.workspaces, null);

    history = await listVersions('CLIENT_CONFIGURATION', source.body.data.id);
    assert.equal(history.body.data[0].lifecycleStatus, 'ACTIVE');
    assert.equal(history.body.data[1].lifecycleStatus, 'VALIDATED');
  });

  it('rejects DRAFT preview and reports/revokes preview metadata', async (context) => {
    if (!ready(context)) return;
    const draft = await api()
      .post(`/api/v1/configuration-versions/${previewVersionId}/draft`)
      .set(auth())
      .send({});
    const rejected = await api()
      .post(`/api/v1/configuration-versions/${draft.body.data.id}/preview-contexts`)
      .set(auth())
      .send({});
    assert.equal(rejected.status, 409);
    assert.equal(
      rejected.body.error.code,
      'CONFIGURATION_PREVIEW_VERSION_NOT_VALIDATED',
    );

    const metadata = await api()
      .get(`/api/v1/configuration-preview-contexts/${previewContextId}`)
      .set(auth());
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.data.mode, 'PREVIEW');
    assert.equal(metadata.body.data.configurationVersionId, previewVersionId);

    const revoked = await api()
      .post(`/api/v1/configuration-preview-contexts/${previewContextId}/revoke`)
      .set(auth())
      .send({});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, 'REVOKED');
    const unusable = await api()
      .get(`/api/v1/configuration-preview-contexts/${previewContextId}/effective`)
      .set(auth());
    assert.equal(unusable.status, 410);
    assert.equal(unusable.body.error.code, 'CONFIGURATION_PREVIEW_REVOKED');
  });

  it('surfaces EXPIRED status and never applies expired preview', async (context) => {
    if (!ready(context)) return;
    const created = await api()
      .post(`/api/v1/configuration-versions/${previewVersionId}/preview-contexts`)
      .set(auth())
      .send({ expiresInMinutes: 1 });
    const id = created.body.data.id;
    await pool!.query(
      `UPDATE configuration_preview_contexts
       SET expires_at=created_at+INTERVAL '1 millisecond' WHERE id=$1`,
      [id],
    );
    const metadata = await api()
      .get(`/api/v1/configuration-preview-contexts/${id}`)
      .set(auth());
    assert.equal(metadata.body.data.status, 'EXPIRED');
    const expired = await api()
      .get(`/api/v1/configuration-preview-contexts/${id}/effective`)
      .set(auth());
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, 'CONFIGURATION_PREVIEW_EXPIRED');
  });

  it('previews navigation and workspace through their existing effective resolvers', async (context) => {
    if (!ready(context)) return;
    const nav = await api()
      .post(`/api/v1/clients/${clientId}/navigation-items`)
      .set(auth())
      .send({
        navigationKey: `PREVIEW_NAV_${suffix()}`,
        label: 'Active Navigation',
        routeReference: '/preview-navigation',
        displayOrder: 0,
        enabled: true,
      });
    let history = await listVersions('NAVIGATION_ITEM', nav.body.data.id);
    await activateVersion(history.body.data[0].id);
    await api()
      .patch(`/api/v1/navigation-items/${nav.body.data.id}`)
      .set(auth())
      .send({ label: 'Preview Navigation' });
    history = await listVersions('NAVIGATION_ITEM', nav.body.data.id);
    const candidate = history.body.data[1].id;
    await action(candidate, 'validate');
    const navContext = await api()
      .post(`/api/v1/configuration-versions/${candidate}/preview-contexts`)
      .set(auth())
      .send({});
    const activeNavigation = await api()
      .get(`/api/v1/clients/${clientId}/navigation/effective`)
      .set(auth());
    assert.equal(activeNavigation.body.data.items[0].label, 'Active Navigation');
    const previewNavigation = await api()
      .get(
        `/api/v1/configuration-preview-contexts/${navContext.body.data.id}/effective`,
      )
      .set(auth());
    assert.equal(previewNavigation.body.data.mode, 'PREVIEW');
    assert.equal(previewNavigation.body.data.navigation.items[0].label, 'Preview Navigation');

    const workspace = await api()
      .post(`/api/v1/clients/${clientId}/workspaces`)
      .set(auth())
      .send({
        workspaceKey: `PREVIEW_WS_${suffix()}`,
        label: 'Active Workspace',
        enabled: true,
      });
    history = await listVersions('WORKSPACE', workspace.body.data.id);
    await activateVersion(history.body.data[0].id);
    await api()
      .patch(`/api/v1/workspaces/${workspace.body.data.id}`)
      .set(auth())
      .send({ label: 'Preview Workspace' });
    history = await listVersions('WORKSPACE', workspace.body.data.id);
    const workspaceCandidate = history.body.data[1].id;
    await action(workspaceCandidate, 'validate');
    const workspaceContext = await api()
      .post(`/api/v1/configuration-versions/${workspaceCandidate}/preview-contexts`)
      .set(auth())
      .send({});
    const activeWorkspaces = await api()
      .get(`/api/v1/clients/${clientId}/workspaces/effective`)
      .set(auth());
    assert.equal(activeWorkspaces.body.data.workspaces[0].label, 'Active Workspace');
    const previewWorkspaces = await api()
      .get(
        `/api/v1/configuration-preview-contexts/${workspaceContext.body.data.id}/effective`,
      )
      .set(auth());
    assert.equal(previewWorkspaces.body.data.workspaces.workspaces[0].label, 'Preview Workspace');
  });
});

describe('BE-27P RBAC and isolation', () => {
  it('requires source manage permission, creator binding, and Data Scope', async (context) => {
    if (!ready(context)) return;
    const path = `/api/v1/configuration-versions/${previewVersionId}/preview-contexts`;
    assert.equal((await api().post(path).send({})).status, 401);
    assert.equal(
      (await api().post(path).set(auth(plainToken)).send({})).status,
      403,
    );
    const crossScope = await api()
      .post(`/api/v1/configuration-versions/${otherVersionId}/preview-contexts`)
      .set(auth())
      .send({});
    assert.equal(crossScope.status, 403);
    assert.equal(crossScope.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-27P OpenAPI', () => {
  it('documents PREVIEW context with final Configuration Audit', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/configuration-versions/{configurationVersionId}/preview-contexts',
      '/configuration-preview-contexts/{configurationPreviewId}',
      '/configuration-preview-contexts/{configurationPreviewId}/effective',
      '/configuration-preview-contexts/{configurationPreviewId}/revoke',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const schema of [
      'ConfigurationPreviewStatus',
      'ConfigurationPreviewContext',
      'CreateConfigurationPreviewRequest',
      'EffectiveConfigurationPreview',
    ]) {
      assert.ok(spec.components.schemas[schema], schema);
    }
    // BE-27Q adds Configuration Audit after the Preview context milestone.
    assert.ok(spec.paths['/configuration-audit']);

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
