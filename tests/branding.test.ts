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

const PORT = 55466;
const DIR = '/tmp/asentra-be27m-pg';
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
let plainToken = '';
let adminUserId = '';
let clientId = '';
let buildingId = '';
let siblingBuildingId = '';
let otherClientId = '';
let otherBuildingId = '';
let otherBrandingId = '';
let clientBrandingId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27M database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string, count = 1) {
  const client = await clientService.createClient({
    code: `BR_${suffix()}`,
    name: 'Branding Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const buildings = [];
  for (let index = 0; index < count; index += 1) {
    buildings.push(
      await buildingService.createBuilding({
        propertyId: property.id,
        code: `B_${suffix()}`,
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

const fullProfile = (brandName: string, logoReference: string) => ({
  brandName,
  logoReference,
  login: {
    title: `${brandName} Login`,
    subtitle: 'Secure facility access',
    showLogo: true,
  },
  portal: { headerTitle: `${brandName} Portal`, showLogo: true },
  report: {
    headerText: `${brandName} Operations`,
    footerText: 'Internal report',
    showLogo: true,
  },
  theme: {
    primaryColor: '#123456',
    secondaryColor: '#654321',
    accentColor: '#00AACC',
    backgroundColor: '#FFFFFF',
    surfaceColor: '#F8FAFC',
    textColor: '#111827',
    fontFamily: 'INTER',
    borderRadius: 'SMALL',
  },
});

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
    TRUNCATE building_configurations,client_configurations,
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

  otherBrandingId = (
    await clientConfigurationRepository.create({
      clientId: otherClientId,
      key: 'BRANDING.PROFILE',
      value: fullProfile('Other Brand', 'branding/other/logo.png'),
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

describe('BE-27M Branding and White Label', () => {
  it('creates, gets, and partially updates constrained branding metadata', async (context) => {
    if (!ready(context)) return;
    const logoReference = 'branding/client-main/logo.png';
    const created = await api()
      .post(`/api/v1/clients/${clientId}/branding`)
      .set(auth())
      .send(fullProfile('Asentra Facilities', logoReference));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    clientBrandingId = created.body.data.id;
    assert.equal(created.body.data.scopeType, 'CLIENT');
    assert.equal(created.body.data.logoReference, logoReference);
    assert.equal(created.body.data.theme.primaryColor, '#123456');

    const stored = (
      await pool!.query(
        'SELECT key,value FROM client_configurations WHERE id=$1',
        [clientBrandingId],
      )
    ).rows[0];
    assert.equal(stored.key, 'BRANDING.PROFILE');
    assert.equal(stored.value.logoReference, logoReference);
    assert.equal(stored.value.logoBytes, undefined);

    assert.equal(
      (
        await api()
          .get(`/api/v1/clients/${clientId}/branding`)
          .set(auth())
      ).status,
      200,
    );
    assert.equal(
      (
        await api()
          .get(`/api/v1/client-branding/${clientBrandingId}`)
          .set(auth())
      ).status,
      200,
    );

    const updated = await api()
      .patch(`/api/v1/client-branding/${clientBrandingId}`)
      .set(auth())
      .send({
        login: { subtitle: 'Updated login message', showLogo: false },
        theme: { primaryColor: '#ABCDEF', borderRadius: 'LARGE' },
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.login.subtitle, 'Updated login message');
    assert.equal(updated.body.data.login.title, 'Asentra Facilities Login');
    assert.equal(updated.body.data.login.showLogo, false);
    assert.equal(updated.body.data.theme.primaryColor, '#ABCDEF');
    assert.equal(updated.body.data.theme.secondaryColor, '#654321');
    await activateLatestConfigurationVersion(
      adminToken,
      'CLIENT_CONFIGURATION',
      clientBrandingId,
    );
  });

  it('returns effective Client branding and whole-profile Building override/fallback', async (context) => {
    if (!ready(context)) return;
    let effective = await api()
      .get(`/api/v1/clients/${clientId}/branding/effective`)
      .set(auth());
    assert.equal(effective.status, 200);
    assert.equal(effective.body.data.branding.brandName, 'Asentra Facilities');

    const building = await api()
      .post(`/api/v1/buildings/${buildingId}/branding`)
      .set(auth())
      .send({
        brandName: 'Tower Brand',
        logoReference: 'branding/tower/logo.svg',
        portal: { headerTitle: 'Tower Operations', showLogo: true },
        theme: { primaryColor: '#224466', fontFamily: 'ROBOTO' },
      });
    assert.equal(building.status, 201, JSON.stringify(building.body));
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      building.body.data.id,
    );
    assert.equal(building.body.data.clientId, clientId);
    assert.equal(building.body.data.buildingId, buildingId);

    effective = await api()
      .get(`/api/v1/buildings/${buildingId}/branding/effective`)
      .set(auth());
    assert.equal(effective.body.data.branding.brandName, 'Tower Brand');
    assert.equal(effective.body.data.branding.theme.primaryColor, '#224466');
    assert.equal(effective.body.data.branding.theme.secondaryColor, '#475569');

    await api()
      .patch(`/api/v1/building-branding/${building.body.data.id}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      building.body.data.id,
    );
    effective = await api()
      .get(`/api/v1/buildings/${buildingId}/branding/effective`)
      .set(auth());
    assert.equal(effective.body.data.branding.brandName, 'Asentra Facilities');
  });

  it('constrains theme tokens, text, and opaque logo references', async (context) => {
    if (!ready(context)) return;
    const invalidBodies = [
      { brandName: 'Bad', customCss: 'body { display:none }' },
      { brandName: 'Bad', theme: { primaryColor: 'red' } },
      { brandName: 'Bad', theme: { fontFamily: 'CustomFont' } },
      { brandName: 'Bad', theme: { customCss: '--x:1' } },
      { brandName: '<script>alert(1)</script>' },
      { brandName: 'Bad', logoReference: 'https://example.com/logo.png' },
      { brandName: 'Bad', logoReference: '../logo.png' },
      { brandName: 'Bad', logoReference: 'data:image/png;base64,abc' },
    ];
    for (const [index, body] of invalidBodies.entries()) {
      const scope = await createScope(adminUserId);
      const response = await api()
        .post(`/api/v1/clients/${scope.client.id}/branding`)
        .set(auth())
        .send(body);
      assert.equal(response.status, 400, `${index}: ${JSON.stringify(response.body)}`);
    }
  });

  it('protects the reserved branding namespace from generic configuration APIs', async (context) => {
    if (!ready(context)) return;
    let response = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({ key: 'BRANDING.PROFILE', value: { customCss: 'unsafe' } });
    assert.equal(response.status, 400);
    assert.equal(
      (
        await api()
          .get(`/api/v1/client-configurations/${clientBrandingId}`)
          .set(auth())
      ).status,
      404,
    );
    response = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(response.body.data.configurations['BRANDING.PROFILE'], undefined);
  });
});

describe('BE-27M RBAC and isolation', () => {
  it('reuses configuration permissions and Client/Building Data Scope', async (context) => {
    if (!ready(context)) return;
    assert.equal(
      (await api().get(`/api/v1/clients/${clientId}/branding/effective`)).status,
      401,
    );
    assert.equal(
      (
        await api()
          .post(`/api/v1/clients/${clientId}/branding`)
          .set(auth(plainToken))
          .send({ brandName: 'Denied' })
      ).status,
      403,
    );
    for (const path of [
      `/api/v1/buildings/${siblingBuildingId}/branding/effective`,
      `/api/v1/buildings/${otherBuildingId}/branding`,
      `/api/v1/clients/${otherClientId}/branding`,
      `/api/v1/client-branding/${otherBrandingId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
  });
});

describe('BE-27M OpenAPI', () => {
  it('documents Branding in the final BE-27 contract', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/clients/{clientId}/branding',
      '/clients/{clientId}/branding/effective',
      '/client-branding/{brandingConfigurationId}',
      '/buildings/{buildingId}/branding',
      '/buildings/{buildingId}/branding/effective',
      '/building-branding/{brandingConfigurationId}',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const schema of [
      'BrandingProfile',
      'BrandingThemeTokens',
      'BrandingConfiguration',
      'CreateBrandingRequest',
      'EffectiveBranding',
    ]) {
      assert.ok(spec.components.schemas[schema], schema);
    }
    assert.ok(
      spec.paths[
        '/configuration-sources/{sourceType}/{sourceConfigurationId}/versions'
      ],
    );

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
