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
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { teamRepository, teamService } from '../src/modules/teams';
import { createAdminUser, createPlainSession } from './helpers/access';
import { activateLatestConfigurationVersion } from './helpers/configuration-lifecycle';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55464;
const DIR = '/tmp/asentra-be27k-pg';
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
let organizationId = '';
let departmentId = '';
let teamId = '';
let positionId = '';
let otherOrganizationId = '';
let otherPresentationId = '';
let clientPresentationId = '';
let buildingPresentationId = '';

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
function ready(context: TestContext): boolean {
  if (!database || !pool) {
    context.skip('BE-27K database unavailable');
    return false;
  }
  return true;
}

async function createScope(userId?: string, count = 1) {
  const client = await clientService.createClient({
    code: `OP_${suffix()}`,
    name: 'Organization Presentation Client',
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
    TRUNCATE building_configurations,client_configurations,positions,teams,
      departments,organizations,user_building_assignments,buildings,properties,
      clients,user_sessions,user_credentials,role_permission_assignments,
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

  const organization = await organizationService.createOrganization({
    clientId,
    code: `ORG_${suffix()}`,
    name: 'Authoritative Organization',
  });
  organizationId = organization.id;
  const department = await departmentService.createDepartment({
    organizationId,
    code: `DEP_${suffix()}`,
    name: 'Authoritative Department',
  });
  departmentId = department.id;
  const team = await teamService.createTeam({
    departmentId,
    code: `TEAM_${suffix()}`,
    name: 'Authoritative Team',
  });
  teamId = team.id;
  const position = await positionService.createPosition({
    organizationId,
    departmentId,
    code: `POS_${suffix()}`,
    name: 'Authoritative Position',
  });
  positionId = position.id;

  const other = await createScope();
  otherClientId = other.client.id;
  otherBuildingId = other.buildings[0].id;
  const otherOrganization = await organizationService.createOrganization({
    clientId: otherClientId,
    code: `OTHER_${suffix()}`,
    name: 'Other Organization',
  });
  otherOrganizationId = otherOrganization.id;
  otherPresentationId = (
    await clientConfigurationRepository.create({
      clientId: otherClientId,
      key: 'PRESENTATION.ORGANIZATION',
      value: {
        labels: {
          organization: null,
          department: null,
          team: null,
          position: null,
        },
        items: [
          {
            entityType: 'ORGANIZATION',
            entityId: otherOrganizationId,
            displayName: null,
            displayOrder: 0,
            visible: true,
          },
        ],
      },
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

const clientPayload = () => ({
  labels: {
    organization: 'Company',
    department: 'Division',
    team: 'Crew',
    position: 'Job Title',
  },
  items: [
    {
      entityType: 'ORGANIZATION',
      entityId: organizationId,
      displayOrder: 30,
      visible: true,
    },
    {
      entityType: 'DEPARTMENT',
      entityId: departmentId,
      displayName: 'Engineering Display',
      displayOrder: 20,
      visible: true,
    },
    {
      entityType: 'TEAM',
      entityId: teamId,
      displayOrder: 10,
      visible: false,
    },
    {
      entityType: 'POSITION',
      entityId: positionId,
      displayName: 'Engineer Display',
      displayOrder: 0,
      visible: true,
    },
  ],
});

describe('BE-27K Organization Presentation Configuration', () => {
  it('creates, gets, and updates presentation metadata without changing BE-03 masters', async (context) => {
    if (!ready(context)) return;
    const before = (
      await pool!.query(
        `SELECT o.name organization_name,d.name department_name,t.name team_name,p.name position_name
           FROM organizations o
           JOIN departments d ON d.organization_id=o.id
           JOIN teams t ON t.department_id=d.id
           JOIN positions p ON p.organization_id=o.id
          WHERE o.id=$1 AND d.id=$2 AND t.id=$3 AND p.id=$4`,
        [organizationId, departmentId, teamId, positionId],
      )
    ).rows[0];

    const created = await api()
      .post(`/api/v1/clients/${clientId}/organization-presentation`)
      .set(auth())
      .send(clientPayload());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    clientPresentationId = created.body.data.id;
    assert.equal(created.body.data.scopeType, 'CLIENT');
    assert.equal(created.body.data.labels.department, 'Division');
    assert.equal(created.body.data.items.length, 4);

    const scoped = await api()
      .get(`/api/v1/clients/${clientId}/organization-presentation`)
      .set(auth());
    assert.equal(scoped.status, 200);
    const byId = await api()
      .get(`/api/v1/client-organization-presentation/${clientPresentationId}`)
      .set(auth());
    assert.equal(byId.status, 200);

    const updated = await api()
      .patch(`/api/v1/client-organization-presentation/${clientPresentationId}`)
      .set(auth())
      .send({ labels: { team: 'Work Group' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.labels.team, 'Work Group');
    assert.equal(updated.body.data.labels.department, 'Division');
    await activateLatestConfigurationVersion(
      adminToken,
      'CLIENT_CONFIGURATION',
      clientPresentationId,
    );

    const after = (
      await pool!.query(
        `SELECT o.name organization_name,d.name department_name,t.name team_name,p.name position_name
           FROM organizations o
           JOIN departments d ON d.organization_id=o.id
           JOIN teams t ON t.department_id=d.id
           JOIN positions p ON p.organization_id=o.id
          WHERE o.id=$1 AND d.id=$2 AND t.id=$3 AND p.id=$4`,
        [organizationId, departmentId, teamId, positionId],
      )
    ).rows[0];
    assert.deepEqual(after, before);
  });

  it('resolves display names, ordering, visibility, and authoritative availability', async (context) => {
    if (!ready(context)) return;
    let effective = await api()
      .get(`/api/v1/clients/${clientId}/organization-presentation/effective`)
      .set(auth());
    assert.equal(effective.status, 200, JSON.stringify(effective.body));
    assert.equal(effective.body.data.labels.department, 'Division');
    assert.deepEqual(
      effective.body.data.items.map((item: any) => item.entityType),
      ['POSITION', 'TEAM', 'DEPARTMENT', 'ORGANIZATION'],
    );
    const department = effective.body.data.items.find(
      (item: any) => item.entityType === 'DEPARTMENT',
    );
    assert.equal(department.authoritativeName, 'Authoritative Department');
    assert.equal(department.effectiveDisplayName, 'Engineering Display');
    assert.equal(
      effective.body.data.items.find((item: any) => item.entityType === 'TEAM')
        .visible,
      false,
    );

    await teamRepository.updateTeam(teamId, { status: 'INACTIVE' });
    effective = await api()
      .get(`/api/v1/clients/${clientId}/organization-presentation/effective`)
      .set(auth());
    const team = effective.body.data.items.find(
      (item: any) => item.entityType === 'TEAM',
    );
    assert.equal(team.available, false);
    assert.equal(team.visible, false);
  });

  it('uses whole-artifact Building override and ACTIVE Client fallback', async (context) => {
    if (!ready(context)) return;
    const building = await api()
      .post(`/api/v1/buildings/${buildingId}/organization-presentation`)
      .set(auth())
      .send({
        labels: { department: 'Building Unit' },
        items: [
          {
            entityType: 'POSITION',
            entityId: positionId,
            displayName: 'Site Engineer',
            displayOrder: 0,
            visible: true,
          },
        ],
      });
    assert.equal(building.status, 201, JSON.stringify(building.body));
    buildingPresentationId = building.body.data.id;
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      buildingPresentationId,
    );
    assert.equal(building.body.data.clientId, clientId);
    assert.equal(building.body.data.buildingId, buildingId);

    let effective = await api()
      .get(`/api/v1/buildings/${buildingId}/organization-presentation/effective`)
      .set(auth());
    assert.equal(effective.status, 200);
    assert.equal(effective.body.data.labels.department, 'Building Unit');
    assert.equal(effective.body.data.items.length, 1);
    assert.equal(effective.body.data.items[0].effectiveDisplayName, 'Site Engineer');

    await api()
      .patch(`/api/v1/building-organization-presentation/${buildingPresentationId}`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    await activateLatestConfigurationVersion(
      adminToken,
      'BUILDING_CONFIGURATION',
      buildingPresentationId,
    );
    effective = await api()
      .get(`/api/v1/buildings/${buildingId}/organization-presentation/effective`)
      .set(auth());
    assert.equal(effective.body.data.items.length, 4);
    assert.equal(effective.body.data.labels.department, 'Division');
  });

  it('rejects wrong-type/cross-Client references and generic namespace bypass', async (context) => {
    if (!ready(context)) return;
    let response = await api()
      .patch(`/api/v1/client-organization-presentation/${clientPresentationId}`)
      .set(auth())
      .send({
        items: [
          {
            entityType: 'ORGANIZATION',
            entityId: otherOrganizationId,
            visible: true,
          },
        ],
      });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'ORGANIZATION_PRESENTATION_REFERENCE_INVALID',
    );

    response = await api()
      .patch(`/api/v1/client-organization-presentation/${clientPresentationId}`)
      .set(auth())
      .send({
        items: [
          { entityType: 'DEPARTMENT', entityId: teamId, visible: true },
        ],
      });
    assert.equal(response.status, 400);

    response = await api()
      .post(`/api/v1/clients/${clientId}/configurations`)
      .set(auth())
      .send({ key: 'PRESENTATION.ORGANIZATION', value: {} });
    assert.equal(response.status, 400);
    assert.equal(
      (
        await api()
          .get(`/api/v1/client-configurations/${clientPresentationId}`)
          .set(auth())
      ).status,
      404,
    );
    response = await api()
      .get(`/api/v1/clients/${clientId}/configurations/effective`)
      .set(auth());
    assert.equal(
      response.body.data.configurations['PRESENTATION.ORGANIZATION'],
      undefined,
    );
  });
});

describe('BE-27K RBAC and isolation', () => {
  it('reuses configuration permissions and Client/Building Data Scope', async (context) => {
    if (!ready(context)) return;
    assert.equal(
      (
        await api().get(
          `/api/v1/clients/${clientId}/organization-presentation/effective`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await api()
          .post(`/api/v1/clients/${clientId}/organization-presentation`)
          .set(auth(plainToken))
          .send({})
      ).status,
      403,
    );
    for (const path of [
      `/api/v1/buildings/${siblingBuildingId}/organization-presentation/effective`,
      `/api/v1/buildings/${otherBuildingId}/organization-presentation`,
      `/api/v1/clients/${otherClientId}/organization-presentation`,
      `/api/v1/client-organization-presentation/${otherPresentationId}`,
    ]) {
      const response = await api().get(path).set(auth());
      assert.equal(response.status, 403, path);
      assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
    }
  });
});

describe('BE-27K OpenAPI', () => {
  it('documents Organization Presentation in the final BE-27 contract', () => {
    const spec: any = parse(
      readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
    );
    for (const path of [
      '/clients/{clientId}/organization-presentation',
      '/clients/{clientId}/organization-presentation/effective',
      '/client-organization-presentation/{organizationPresentationId}',
      '/buildings/{buildingId}/organization-presentation',
      '/buildings/{buildingId}/organization-presentation/effective',
      '/building-organization-presentation/{organizationPresentationId}',
    ]) {
      assert.ok(spec.paths[path], path);
    }
    for (const schema of [
      'OrganizationPresentationLabels',
      'OrganizationPresentationItem',
      'OrganizationPresentationConfiguration',
      'CreateOrganizationPresentationRequest',
      'EffectiveOrganizationPresentation',
    ]) {
      assert.ok(spec.components.schemas[schema], schema);
    }
    assert.ok(spec.paths['/clients/{clientId}/cms-content']);

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
