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
import { cmsContentRepository } from '../src/modules/cms-content/cms-content.repository';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55465;
const DIR = '/tmp/asentra-be27l-pg';
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
let otherClientId = '';
let otherBuildingId = '';
let otherContentId = '';
let announcementId = '';

const suffix = () => randomUUID().slice(0, 8).toLowerCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27L database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string, count = 1) {
  const client = await clientService.createClient({
    code: `CMS_${suffix().toUpperCase()}`,
    name: 'CMS Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix().toUpperCase()}`,
    name: 'Property',
  });
  const buildings = [];
  for (let index = 0; index < count; index += 1) {
    buildings.push(
      await buildingService.createBuilding({
        propertyId: property.id,
        code: `B_${suffix().toUpperCase()}`,
        name: `Building ${index}`,
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
    TRUNCATE cms_content,building_configurations,client_configurations,
      user_building_assignments,buildings,properties,clients,user_sessions,
      user_credentials,role_permission_assignments,user_role_assignments,
      permissions,roles,users CASCADE
  `);
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  plainToken = await createPlainSession();

  const primary = await createScope(adminUserId, 2);
  clientId = primary.client.id;
  buildingId = primary.buildings[0].id;
  siblingBuildingId = primary.buildings[1].id;
  const other = await createScope();
  otherClientId = other.client.id;
  otherBuildingId = other.buildings[0].id;

  otherContentId = (
    await cmsContentRepository.create({
      scopeType: 'CLIENT',
      clientId: otherClientId,
      buildingId: null,
      contentType: 'HELP',
      slug: 'other-help',
      title: 'Other Help',
      body: 'Other Client content.',
      status: 'DRAFT',
      createdByUserId: adminUserId,
      publishedAt: null,
      publishedByUserId: null,
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

describe('BE-27L CMS Content', () => {
  it('creates, lists, gets, publishes, and exposes publish metadata', async (context) => {
    if (!ready(context)) return;
    const created = await api()
      .post(`/api/v1/clients/${clientId}/cms-content`)
      .set(auth())
      .send({
        contentType: 'announcement',
        slug: 'welcome-news',
        title: 'Welcome News',
        body: '# Welcome\n\nThis is **safe Markdown**.',
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    announcementId = created.body.data.id;
    assert.equal(created.body.data.contentType, 'ANNOUNCEMENT');
    assert.equal(created.body.data.status, 'DRAFT');
    assert.equal(created.body.data.publishedAt, null);

    const list = await api()
      .get(`/api/v1/clients/${clientId}/cms-content?status=DRAFT`)
      .set(auth());
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((entry: any) => entry.id === announcementId));
    assert.equal(
      (
        await api()
          .get(`/api/v1/client-cms-content/${announcementId}`)
          .set(auth())
      ).status,
      200,
    );

    let effective = await api()
      .get(`/api/v1/clients/${clientId}/cms-content/effective`)
      .set(auth());
    assert.equal(effective.status, 200);
    assert.equal(effective.body.data.content.length, 0);

    const published = await api()
      .patch(`/api/v1/client-cms-content/${announcementId}`)
      .set(auth())
      .send({ status: 'PUBLISHED' });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.data.publishedByUserId, adminUserId);
    assert.ok(published.body.data.publishedAt);
    await activateLatestConfigurationVersion(
      adminToken,
      'CMS_CONTENT',
      announcementId,
    );

    effective = await api()
      .get(`/api/v1/clients/${clientId}/cms-content/effective?contentType=ANNOUNCEMENT`)
      .set(auth());
    assert.equal(effective.body.data.content.length, 1);
    assert.equal(effective.body.data.content[0].slug, 'welcome-news');

    const republished = await api()
      .patch(`/api/v1/client-cms-content/${announcementId}`)
      .set(auth())
      .send({ body: 'Updated **safe** content.' });
    assert.equal(republished.status, 200);
    assert.equal(republished.body.data.status, 'PUBLISHED');
    assert.equal(republished.body.data.publishedByUserId, adminUserId);
    assert.equal(republished.body.data.body, 'Updated **safe** content.');
  });

  it('supports the bounded CMS content type catalogue', async (context) => {
    if (!ready(context)) return;
    for (const contentType of [
      'HELP',
      'FAQ',
      'KNOWLEDGE',
      'PORTAL_CONTENT',
      'RELEASE_INFORMATION',
    ]) {
      const response = await api()
        .post(`/api/v1/clients/${clientId}/cms-content`)
        .set(auth())
        .send({
          contentType,
          slug: `${contentType.toLowerCase()}-${suffix()}`,
          title: `${contentType} title`,
          body: `${contentType} safe content`,
        });
      assert.equal(response.status, 201, `${contentType}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.data.contentType, contentType);
    }
  });

  it('applies PUBLISHED Building override and Client fallback by type/slug', async (context) => {
    if (!ready(context)) return;
    const building = await api()
      .post(`/api/v1/buildings/${buildingId}/cms-content`)
      .set(auth())
      .send({
        contentType: 'ANNOUNCEMENT',
        slug: 'welcome-news',
        title: 'Building Welcome',
        body: 'Building-specific announcement.',
        status: 'PUBLISHED',
      });
    assert.equal(building.status, 201, JSON.stringify(building.body));
    await activateLatestConfigurationVersion(
      adminToken,
      'CMS_CONTENT',
      building.body.data.id,
    );
    assert.equal(building.body.data.clientId, clientId);
    assert.equal(building.body.data.buildingId, buildingId);
    assert.equal(building.body.data.publishedByUserId, adminUserId);

    let effective = await api()
      .get(`/api/v1/buildings/${buildingId}/cms-content/effective?contentType=ANNOUNCEMENT`)
      .set(auth());
    assert.equal(effective.status, 200);
    assert.equal(effective.body.data.content.length, 1);
    assert.equal(effective.body.data.content[0].title, 'Building Welcome');
    assert.equal(effective.body.data.content[0].scopeType, 'BUILDING');

    await api()
      .patch(`/api/v1/building-cms-content/${building.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    await activateLatestConfigurationVersion(
      adminToken,
      'CMS_CONTENT',
      building.body.data.id,
    );
    effective = await api()
      .get(`/api/v1/buildings/${buildingId}/cms-content/effective?contentType=ANNOUNCEMENT`)
      .set(auth());
    assert.equal(effective.body.data.content[0].title, 'Welcome News');
    assert.equal(effective.body.data.content[0].scopeType, 'CLIENT');
  });

  it('rejects executable/raw HTML content while accepting safe Markdown', async (context) => {
    if (!ready(context)) return;
    const unsafeBodies = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[unsafe](javascript:alert(1))',
      '[unsafe](data:text/html;base64,abc)',
    ];
    for (const [index, body] of unsafeBodies.entries()) {
      const response = await api()
        .post(`/api/v1/clients/${clientId}/cms-content`)
        .set(auth())
        .send({
          contentType: 'HELP',
          slug: `unsafe-${index}`,
          title: 'Unsafe content',
          body,
        });
      assert.equal(response.status, 400, body);
    }
    const safe = await api()
      .post(`/api/v1/buildings/${buildingId}/cms-content`)
      .set(auth())
      .send({
        contentType: 'HELP',
        slug: 'safe-markdown',
        title: 'Safe Help',
        body: '## Help\n\nUse [the portal](https://example.com/help).',
      });
    assert.equal(safe.status, 201, JSON.stringify(safe.body));
  });
});

describe('BE-27L RBAC and isolation', () => {
  it('reuses configuration permissions and Client/Building Data Scope', async (context) => {
    if (!ready(context)) return;
    assert.equal(
      (
        await api().get(`/api/v1/clients/${clientId}/cms-content/effective`)
      ).status,
      401,
    );
    assert.equal(
      (
        await api()
          .post(`/api/v1/clients/${clientId}/cms-content`)
          .set(auth(plainToken))
          .send({
            contentType: 'HELP',
            slug: 'denied',
            title: 'Denied',
            body: 'Denied',
          })
      ).status,
      403,
    );
    for (const path of [
      `/api/v1/buildings/${siblingBuildingId}/cms-content`,
      `/api/v1/buildings/${otherBuildingId}/cms-content/effective`,
      `/api/v1/clients/${otherClientId}/cms-content`,
      `/api/v1/client-cms-content/${otherContentId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
  });
});

describe('BE-27L OpenAPI', () => {
  it('documents CMS Content in the final BE-27 contract and validates local references', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/clients/{clientId}/cms-content',
      '/clients/{clientId}/cms-content/effective',
      '/client-cms-content/{cmsContentId}',
      '/buildings/{buildingId}/cms-content',
      '/buildings/{buildingId}/cms-content/effective',
      '/building-cms-content/{cmsContentId}',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const schema of [
      'CmsContentType',
      'CmsContentStatus',
      'CmsContent',
      'CreateCmsContentRequest',
      'EffectiveCmsContent',
    ]) {
      assert.ok(spec.components.schemas[schema], schema);
    }
    assert.ok(spec.paths['/clients/{clientId}/branding']);

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
