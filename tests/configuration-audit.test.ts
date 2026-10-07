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
import { recordConfigurationAuditEvent } from '../src/modules/configuration-audit';
import { captureConfigurationVersion } from '../src/modules/configuration-versions';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55470;
const DIR = '/tmp/asentra-be27q-pg';
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
let configurationId = '';
let firstVersionId = '';
let secondVersionId = '';
let auditEventId = '';
let inaccessibleAuditId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27Q database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string) {
  const client = await clientService.createClient({
    code: `AUD_${suffix()}`,
    name: 'Configuration Audit Client',
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

async function lifecycle(
  id: string,
  action: 'validate' | 'publish' | 'activate',
) {
  return api()
    .post(`/api/v1/configuration-versions/${id}/${action}`)
    .set(auth())
    .send({});
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
    TRUNCATE operational_events,configuration_preview_contexts,
      configuration_version_transitions,configuration_version_validations,
      configuration_versions,building_configurations,client_configurations,
      user_building_assignments,buildings,properties,clients,user_sessions,
      user_credentials,role_permission_assignments,user_role_assignments,
      permissions,roles,users CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();
  const own = await createScope(adminUserId);
  clientId = own.client.id;
  buildingId = own.building.id;
  const other = await createScope();
  otherClientId = other.client.id;
  otherBuildingId = other.building.id;
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (postgres) await postgres.stop();
  } finally {
    await rm(DIR, { recursive: true, force: true });
  }
  database = null;
  pool = null;
  postgres = null;
});

describe('BE-27Q Configuration Audit', () => {
  it('records draft, validation, lifecycle, supersede, and preview-access history', async (context) => {
    if (!ready(context)) return;
    const created = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({ key: 'AUDIT.FLAG', value: 'do-not-audit-this-value' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    configurationId = created.body.data.id;

    let versions = await api()
      .get(
        `/api/v1/configuration-sources/CLIENT_CONFIGURATION/${configurationId}/versions`,
      )
      .set(auth());
    firstVersionId = versions.body.data[0].id;
    assert.equal((await lifecycle(firstVersionId, 'validate')).status, 200);
    assert.equal((await lifecycle(firstVersionId, 'publish')).status, 200);
    assert.equal((await lifecycle(firstVersionId, 'activate')).status, 200);

    const updated = await api()
      .patch(`/api/v1/client-configurations/${configurationId}`)
      .set(auth())
      .send({ value: 'another-sensitive-configuration-value' });
    assert.equal(updated.status, 200);
    versions = await api()
      .get(
        `/api/v1/configuration-sources/CLIENT_CONFIGURATION/${configurationId}/versions`,
      )
      .set(auth());
    secondVersionId = versions.body.data[1].id;
    assert.equal((await lifecycle(secondVersionId, 'validate')).status, 200);

    const preview = await api()
      .post(`/api/v1/configuration-versions/${secondVersionId}/preview-contexts`)
      .set(auth())
      .send({ expiresInMinutes: 30 });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    const previewId = preview.body.data.id;
    assert.equal(
      (
        await api()
          .get(`/api/v1/configuration-preview-contexts/${previewId}/effective`)
          .set(auth())
      ).status,
      200,
    );
    assert.equal(
      (
        await api()
          .post(`/api/v1/configuration-preview-contexts/${previewId}/revoke`)
          .set(auth())
          .send({})
      ).status,
      200,
    );
    assert.equal((await lifecycle(secondVersionId, 'publish')).status, 200);
    assert.equal((await lifecycle(secondVersionId, 'activate')).status, 200);

    const malformed = await captureConfigurationVersion(
      {
        sourceType: 'CLIENT_CONFIGURATION',
        sourceConfigurationId: configurationId,
        clientId,
        buildingId: null,
        status: 'ACTIVE',
        snapshot: { id: randomUUID(), clientId, buildingId: null },
      },
      adminUserId,
    );
    const failed = await lifecycle(malformed.id, 'validate');
    assert.equal(failed.status, 200);
    assert.equal(failed.body.data.validation.valid, false);

    const response = await api()
      .get('/api/v1/configuration-audit')
      .query({ configurationId })
      .set(auth());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const events = response.body.data;
    const actions = new Set(events.map((event: any) => event.action));
    for (const action of [
      'CONFIGURATION_DRAFT_CREATED',
      'CONFIGURATION_DRAFT_UPDATED',
      'CONFIGURATION_VALIDATION_SUCCEEDED',
      'CONFIGURATION_VALIDATION_FAILED',
      'CONFIGURATION_PUBLISHED',
      'CONFIGURATION_ACTIVATED',
      'CONFIGURATION_SUPERSEDED',
      'CONFIGURATION_PREVIEW_CREATED',
      'CONFIGURATION_PREVIEW_ACCESSED',
      'CONFIGURATION_PREVIEW_REVOKED',
    ]) {
      assert.ok(actions.has(action), action);
    }
    const activated = events.find(
      (event: any) =>
        event.action === 'CONFIGURATION_ACTIVATED' &&
        event.configurationVersionId === secondVersionId,
    );
    assert.ok(activated);
    auditEventId = activated.id;
    assert.equal(activated.configurationId, configurationId);
    assert.equal(activated.actorUserId, adminUserId);
    assert.equal(activated.clientId, clientId);
    assert.equal(activated.buildingId, null);
    assert.equal(activated.previousStatus, 'PUBLISHED');
    assert.equal(activated.newStatus, 'ACTIVE');
    assert.equal(activated.metadata.previousVersionId, firstVersionId);
    assert.ok(!Number.isNaN(Date.parse(activated.occurredAt)));

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('do-not-audit-this-value'), false);
    assert.equal(
      serialized.includes('another-sensitive-configuration-value'),
      false,
    );
    assert.equal(serialized.toLowerCase().includes('token'), false);
  });

  it('returns configuration and version filters and explicit Building context', async (context) => {
    if (!ready(context)) return;
    const building = await api()
      .post(`/api/v1/buildings/${buildingId}/configurations`)
      .set(auth())
      .send({ key: 'AUDIT.BUILDING', value: true });
    assert.equal(building.status, 201, JSON.stringify(building.body));
    const byVersion = await api()
      .get('/api/v1/configuration-audit')
      .query({
        configurationVersionId: secondVersionId,
        action: 'CONFIGURATION_ACTIVATED',
        sourceType: 'CLIENT_CONFIGURATION',
      })
      .set(auth());
    assert.equal(byVersion.status, 200);
    assert.equal(byVersion.body.data.length, 1);
    assert.equal(byVersion.body.data[0].id, auditEventId);

    const buildingEvents = await api()
      .get('/api/v1/configuration-audit')
      .query({ configurationId: building.body.data.id, buildingId })
      .set(auth());
    assert.equal(buildingEvents.status, 200);
    assert.equal(buildingEvents.body.data.length, 1);
    assert.equal(buildingEvents.body.data[0].clientId, clientId);
    assert.equal(buildingEvents.body.data[0].buildingId, buildingId);
  });

  it('preserves Client/Building isolation for list and single-event reads', async (context) => {
    if (!ready(context)) return;
    await recordConfigurationAuditEvent({
      configurationId: randomUUID(),
      configurationVersionId: null,
      sourceType: 'BUILDING_CONFIGURATION',
      action: 'CONFIGURATION_DRAFT_CREATED',
      actorUserId: adminUserId,
      clientId: otherClientId,
      buildingId: otherBuildingId,
      previousStatus: null,
      newStatus: 'DRAFT',
      summary: 'Inaccessible configuration draft created.',
    });
    const row = await pool!.query<{ id: string }>(
      `SELECT id FROM operational_events
       WHERE entity_type='CONFIGURATION' AND client_id=$1 LIMIT 1`,
      [otherClientId],
    );
    inaccessibleAuditId = row.rows[0].id;

    const list = await api().get('/api/v1/configuration-audit').set(auth());
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((event: any) => event.id === inaccessibleAuditId),
      false,
    );
    const read = await api()
      .get(`/api/v1/configuration-audit/${inaccessibleAuditId}`)
      .set(auth());
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');
    assert.equal(
      (
        await api()
          .get(`/api/v1/configuration-audit/${auditEventId}`)
          .set(auth())
      ).status,
      200,
    );
  });

  it('is authenticated, permission-gated, and exposes no write API', async (context) => {
    if (!ready(context)) return;
    assert.equal((await api().get('/api/v1/configuration-audit')).status, 401);
    assert.equal(
      (
        await api()
          .get('/api/v1/configuration-audit')
          .set(auth(plainToken))
      ).status,
      403,
    );
    assert.equal(
      (
        await api()
          .post('/api/v1/configuration-audit')
          .set(auth())
          .send({})
      ).status,
      404,
    );
    assert.equal(
      (
        await api()
          .delete(`/api/v1/configuration-audit/${auditEventId}`)
          .set(auth())
      ).status,
      404,
    );
  });

  it('validates audit identifiers and filters', async (context) => {
    if (!ready(context)) return;
    assert.equal(
      (
        await api()
          .get('/api/v1/configuration-audit/not-a-uuid')
          .set(auth())
      ).status,
      400,
    );
    assert.equal(
      (
        await api()
          .get('/api/v1/configuration-audit')
          .query({ action: 'NOT_AN_AUDIT_ACTION' })
          .set(auth())
      ).status,
      400,
    );
    assert.equal(
      (
        await api()
          .get('/api/v1/configuration-audit')
          .query({ from: '2026-08-19', to: '2026-08-18' })
          .set(auth())
      ).status,
      400,
    );
  });
});

describe('BE-27Q OpenAPI', () => {
  it('documents the read-only audit contract and resolves local references', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    const list = spec.paths['/configuration-audit'];
    const read =
      spec.paths['/configuration-audit/{configurationAuditEventId}'];
    assert.ok(list?.get);
    assert.ok(read?.get);
    for (const method of ['post', 'put', 'patch', 'delete']) {
      assert.equal(list[method], undefined);
      assert.equal(read[method], undefined);
    }
    assert.ok(spec.components.schemas.ConfigurationAuditAction);
    assert.ok(spec.components.schemas.ConfigurationAuditEvent);

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
