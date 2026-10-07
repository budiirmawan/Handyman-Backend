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

const PORT = 55468;
const DIR = '/tmp/asentra-be27o-pg';
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
let sourceId = '';
let version1 = '';
let version2 = '';
let invalidVersion = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27O database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string) {
  const client = await clientService.createClient({
    code: `LC_${suffix()}`,
    name: 'Lifecycle Client',
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
    TRUNCATE configuration_version_transitions,
      configuration_version_validations,configuration_versions,
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
    key: 'LIFECYCLE.OTHER',
    value: 'other',
    status: 'ACTIVE',
  });
  otherVersionId = (
    await captureConfigurationVersion(
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
    )
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

async function versions() {
  return api()
    .get(
      `/api/v1/configuration-sources/CLIENT_CONFIGURATION/${sourceId}/versions`,
    )
    .set(auth());
}

async function transition(id: string, action: 'validate' | 'publish' | 'activate') {
  return api()
    .post(`/api/v1/configuration-versions/${id}/${action}`)
    .set(auth())
    .send({});
}

describe('BE-27O Draft Validate Publish lifecycle', () => {
  it('creates DRAFT, validates, publishes, and activates only valid versions', async (context) => {
    if (!ready(context)) return;
    const created = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({ key: 'LIFECYCLE.FLAG', value: 'v1' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sourceId = created.body.data.id;
    let history = await versions();
    version1 = history.body.data[0].id;
    assert.equal(history.body.data[0].lifecycleStatus, 'DRAFT');

    let effective = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.body.data.configurations['LIFECYCLE.FLAG'], undefined);
    assert.equal((await transition(version1, 'publish')).status, 409);

    const validated = await transition(version1, 'validate');
    assert.equal(validated.status, 200, JSON.stringify(validated.body));
    assert.equal(validated.body.data.validation.valid, true);
    assert.deepEqual(validated.body.data.validation.errors, []);
    assert.equal(validated.body.data.version.lifecycleStatus, 'VALIDATED');

    const validationList = await api()
      .get(`/api/v1/configuration-versions/${version1}/validations`)
      .set(auth());
    assert.equal(validationList.body.data.length, 1);
    assert.equal(validationList.body.data[0].validatedByUserId, adminUserId);

    const published = await transition(version1, 'publish');
    assert.equal(published.status, 200);
    assert.equal(published.body.data.lifecycleStatus, 'PUBLISHED');
    const activated = await transition(version1, 'activate');
    assert.equal(activated.status, 200);
    assert.equal(activated.body.data.lifecycleStatus, 'ACTIVE');

    effective = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.body.data.configurations['LIFECYCLE.FLAG'], 'v1');
  });

  it('failed validation leaves ACTIVE version and effective configuration unchanged', async (context) => {
    if (!ready(context)) return;
    const updated = await api()
      .patch(`/api/v1/client-configurations/${sourceId}`)
      .set(auth())
      .send({ value: 'v2' });
    assert.equal(updated.status, 200);
    let history = await versions();
    version2 = history.body.data[1].id;
    assert.equal(history.body.data[1].lifecycleStatus, 'DRAFT');

    let effective = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.body.data.configurations['LIFECYCLE.FLAG'], 'v1');

    invalidVersion = (
      await captureConfigurationVersion(
        {
          sourceType: 'CLIENT_CONFIGURATION',
          sourceConfigurationId: sourceId,
          clientId,
          buildingId: null,
          status: 'ACTIVE',
          snapshot: {
            id: randomUUID(),
            clientId,
            key: 'LIFECYCLE.FLAG',
            value: 'invalid',
            status: 'ACTIVE',
          },
        },
        adminUserId,
      )
    ).id;
    const failed = await transition(invalidVersion, 'validate');
    assert.equal(failed.status, 200);
    assert.equal(failed.body.data.validation.valid, false);
    assert.equal(
      failed.body.data.validation.errors[0].code,
      'SNAPSHOT_SOURCE_MISMATCH',
    );
    assert.equal(failed.body.data.version.lifecycleStatus, 'DRAFT');
    assert.equal((await transition(invalidVersion, 'publish')).status, 409);

    history = await versions();
    assert.equal(
      history.body.data.find((entry: any) => entry.id === version1)
        .lifecycleStatus,
      'ACTIVE',
    );
    effective = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.body.data.configurations['LIFECYCLE.FLAG'], 'v1');
  });

  it('activates a validated replacement and atomically supersedes prior ACTIVE', async (context) => {
    if (!ready(context)) return;
    assert.equal((await transition(version2, 'validate')).status, 200);
    assert.equal((await transition(version2, 'publish')).status, 200);
    assert.equal((await transition(version2, 'activate')).status, 200);

    const history = await versions();
    const first = history.body.data.find((entry: any) => entry.id === version1);
    const second = history.body.data.find((entry: any) => entry.id === version2);
    assert.equal(first.lifecycleStatus, 'SUPERSEDED');
    assert.equal(second.lifecycleStatus, 'ACTIVE');
    assert.equal(
      history.body.data.find((entry: any) => entry.id === invalidVersion)
        .lifecycleStatus,
      'DRAFT',
    );
    assert.equal(
      Number(
        (
          await pool!.query(
            `SELECT COUNT(*)::int count FROM configuration_versions
             WHERE source_type='CLIENT_CONFIGURATION'
               AND source_configuration_id=$1 AND lifecycle_status='ACTIVE'`,
            [sourceId],
          )
        ).rows[0].count,
      ),
      1,
    );
    const transitions = await pool!.query(
      `SELECT from_status,to_status,transitioned_by_user_id
       FROM configuration_version_transitions
       WHERE configuration_version_id=ANY($1::uuid[])
       ORDER BY transitioned_at`,
      [[version1, version2]],
    );
    assert.ok(
      transitions.rows.some(
        (row) => row.from_status === 'ACTIVE' && row.to_status === 'SUPERSEDED',
      ),
    );
    assert.ok(
      transitions.rows.every(
        (row) => row.transitioned_by_user_id === adminUserId,
      ),
    );

    const effective = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.body.data.configurations['LIFECYCLE.FLAG'], 'v2');
  });

  it('clones immutable history into a new DRAFT without changing ACTIVE', async (context) => {
    if (!ready(context)) return;
    const draft = await api()
      .post(`/api/v1/configuration-versions/${version2}/draft`)
      .set(auth())
      .send({});
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    assert.equal(draft.body.data.lifecycleStatus, 'DRAFT');
    assert.equal(draft.body.data.snapshot.value, 'v2');
    assert.ok(draft.body.data.versionNumber > 2);
    const effective = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(effective.body.data.configurations['LIFECYCLE.FLAG'], 'v2');
  });
});

describe('BE-27O RBAC and isolation', () => {
  it('requires source manage permission and existing Client/Building Data Scope', async (context) => {
    if (!ready(context)) return;
    const path = `/api/v1/configuration-versions/${version2}/draft`;
    assert.equal((await api().post(path).send({})).status, 401);
    assert.equal(
      (await api().post(path).set(auth(plainToken)).send({})).status,
      403,
    );
    const inaccessible = await api()
      .post(`/api/v1/configuration-versions/${otherVersionId}/validate`)
      .set(auth())
      .send({});
    assert.equal(inaccessible.status, 403);
    assert.equal(inaccessible.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('BE-27O OpenAPI', () => {
  it('documents lifecycle actions with final Preview and Audit surfaces', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/configuration-versions/{configurationVersionId}/draft',
      '/configuration-versions/{configurationVersionId}/validate',
      '/configuration-versions/{configurationVersionId}/publish',
      '/configuration-versions/{configurationVersionId}/activate',
      '/configuration-versions/{configurationVersionId}/validations',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const schema of [
      'ConfigurationLifecycleStatus',
      'ConfigurationValidation',
      'ConfigurationValidationOutcome',
    ]) {
      assert.ok(spec.components.schemas[schema], schema);
    }
    assert.ok(
      spec.paths[
        '/configuration-preview-contexts/{configurationPreviewId}/effective'
      ],
    );
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
