import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { teamService } from '../src/modules/teams';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceReportingService } from '../src/modules/workforce-reporting';
import { workforceService } from '../src/modules/workforce';
import { workforceShiftService } from '../src/modules/workforce-shifts';
import { externalWorkforceService } from '../src/modules/external-workforce';
import { parseWorkforceReportingQuery } from '../src/modules/workforce-reporting/workforce-reporting.validation';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, clients CASCADE');
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

function authHeaders(token = adminToken): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

async function seedReportingFixture() {
  const client = await clientService.createClient({
    code: `CLI_API_${suffix()}`,
    name: 'Reporting API Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_API_${suffix()}`,
    name: 'Reporting API Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_API_${suffix()}`,
    name: 'Reporting API Building',
    timezone: 'Asia/Jakarta',
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_API_${suffix()}`,
    name: 'Reporting API Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_API_${suffix()}`,
    name: 'Reporting API Dept',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `TEAM_API_${suffix()}`,
    name: 'Reporting API Team',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_API_${suffix()}`,
    name: 'Reporting API Position',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  const first = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    employeeCode: `WF_API_${suffix()}`,
    fullName: 'First Reporting Worker',
    workforceType: 'INTERNAL',
  });
  const second = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    employeeCode: `WF_API_${suffix()}`,
    fullName: 'Second Reporting Worker',
    workforceType: 'EXTERNAL',
  });
  const shift = await shiftService.createShift({
    clientId: client.id,
    buildingId: building.id,
    code: `SHIFT_API_${suffix()}`,
    name: 'API Morning',
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
  const externalOrgId = randomUUID();
  await pool!.query(
    `INSERT INTO external_organizations (id, client_id, code, name, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`,
    [externalOrgId, client.id, `VND_API_${suffix()}`, 'API Vendor'],
  );
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: first.id,
    buildingId: building.id,
  });
  await workforceShiftService.assignShiftToWorkforce({
    workforceProfileId: second.id,
    shiftId: shift.id,
  });
  await externalWorkforceService.createExternalWorkforceLink({
    workforceProfileId: second.id,
    externalOrganizationId: externalOrgId,
    externalPersonnelCode: `VAPI_${suffix()}`,
  });

  return {
    client,
    property,
    building,
    organization,
    department,
    team,
    position,
    first,
    second,
    shift,
    externalOrgId,
  };
}

describe('BE-03I2 workforce reporting query API validation', () => {
  it('applies defaults and validates filters', () => {
    assert.deepEqual(parseWorkforceReportingQuery({}), {
      page: 1,
      limit: 50,
    });

    const parsed = parseWorkforceReportingQuery({
      organizationId: randomUUID(),
      departmentId: randomUUID(),
      teamId: randomUUID(),
      positionId: randomUUID(),
      buildingId: randomUUID(),
      shiftId: randomUUID(),
      externalOrganizationId: randomUUID(),
      workforceType: 'external',
      status: 'inactive',
      includeInactive: 'false',
      page: '2',
      limit: '10',
    });
    assert.equal(parsed.page, 2);
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.workforceType, 'EXTERNAL');
    assert.equal(parsed.status, 'INACTIVE');
    assert.equal(parsed.includeInactive, false);
  });

  it('rejects invalid uuid, enum, pagination, and conflicting status options', () => {
    assert.throws(
      () => parseWorkforceReportingQuery({ organizationId: 'not-a-uuid' }),
      /Request validation failed/,
    );
    assert.throws(
      () => parseWorkforceReportingQuery({ workforceType: 'VENDOR' }),
      /Request validation failed/,
    );
    assert.throws(
      () => parseWorkforceReportingQuery({ page: '0' }),
      /Request validation failed/,
    );
    assert.throws(
      () => parseWorkforceReportingQuery({ limit: '101' }),
      /Request validation failed/,
    );
    assert.throws(
      () =>
        parseWorkforceReportingQuery({
          status: 'INACTIVE',
          includeInactive: 'true',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const details = (
          error as { details?: Array<{ message?: string }> }
        ).details;
        assert.equal(
          details?.[0]?.message,
          'Do not set status when includeInactive is true.',
        );
        return true;
      },
    );
  });
});

describe('GET /api/v1/workforce/reporting', () => {
  it('requires workforce.read permission', async (t) => {
    if (!requireDatabase(t)) return;
    const token = await createPlainSession();
    const response = await api()
      .get('/api/v1/workforce/reporting')
      .set(authHeaders(token));
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('returns paginated workforce reporting records isolated by accessible building', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await seedReportingFixture();

    const response = await api()
      .get('/api/v1/workforce/reporting?limit=1&page=1')
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(Array.isArray(response.body.data), true);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.meta.limit, 1);
    assert.equal(response.body.meta.page, 1);
    assert.ok(response.body.meta.total >= 2);
    const ids = response.body.data.map((item: { profile: { id: string } }) => item.profile.id);
    assert.ok(ids.includes(fixture.first.id) || ids.includes(fixture.second.id));
  });

  it('filters by organization, department, team, position, workforce type, and shift', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await seedReportingFixture();

    const response = await api()
      .get('/api/v1/workforce/reporting')
      .query({
        organizationId: fixture.organization.id,
        departmentId: fixture.department.id,
        teamId: fixture.team.id,
        positionId: fixture.position.id,
        workforceType: 'EXTERNAL',
        shiftId: fixture.shift.id,
      })
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].profile.id, fixture.second.id);
    assert.equal(response.body.data[0].shifts[0].shiftId, fixture.shift.id);
    assert.equal(response.body.meta.total, 1);
  });

  it('filters by building and external organization where applicable', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await seedReportingFixture();

    const response = await api()
      .get('/api/v1/workforce/reporting')
      .query({
        buildingId: fixture.building.id,
        externalOrganizationId: fixture.externalOrgId,
      })
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 0);
    assert.equal(response.body.meta.total, 0);

    const externalResponse = await api()
      .get('/api/v1/workforce/reporting')
      .query({ externalOrganizationId: fixture.externalOrgId })
      .set(authHeaders());
    assert.equal(externalResponse.status, 200);
    assert.equal(externalResponse.body.data.length, 1);
    assert.equal(externalResponse.body.data[0].profile.id, fixture.second.id);
    assert.equal(
      externalResponse.body.data[0].externalAffiliations[0].externalOrganizationId,
      fixture.externalOrgId,
    );
  });

  it('returns 400 for invalid filters', async (t) => {
    if (!requireDatabase(t)) return;

    const invalid = await api()
      .get('/api/v1/workforce/reporting?workforceType=bad')
      .set(authHeaders());
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/v1/workforce/reporting/:id', () => {
  it('returns a detailed scoped workforce reporting record', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await seedReportingFixture();

    const response = await api()
      .get(`/api/v1/workforce/reporting/${fixture.first.id}`)
      .set(authHeaders());

    assert.equal(response.status, 200);
    assert.equal(response.body.data.profile.id, fixture.first.id);
    assert.equal(response.body.data.organization.id, fixture.organization.id);
    assert.equal(response.body.data.department.id, fixture.department.id);
    assert.equal(response.body.data.team?.id, fixture.team.id);
    assert.equal(response.body.data.position.id, fixture.position.id);
    assert.equal(
      response.body.data.buildingAssignments[0].buildingId,
      fixture.building.id,
    );
  });

  it('returns 404 for an inaccessible or unknown workforce profile', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get(`/api/v1/workforce/reporting/${randomUUID()}`)
      .set(authHeaders());

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');
  });

  it('rejects malformed ids and unscoped service reads', async (t) => {
    if (!requireDatabase(t)) return;

    const response = await api()
      .get('/api/v1/workforce/reporting/not-a-uuid')
      .set(authHeaders(adminToken));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');

    await assert.rejects(
      workforceReportingService.getRequiredWorkforceReporting(randomUUID()),
      /requires a client or accessible-building scope/,
    );
  });
});
