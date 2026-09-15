import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { parseConfig } from '../src/config';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import { createAdminSession } from './helpers/access';
import { api } from './helpers/http';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { skillService } from '../src/modules/skills';
import { teamService } from '../src/modules/teams';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceReportingLineService } from '../src/modules/workforce-reporting-lines';
import { workforceService } from '../src/modules/workforce';
import { workforceShiftService } from '../src/modules/workforce-shifts';
import { workforceSkillService } from '../src/modules/workforce-skills';

const DB_PORT = 55433;
const DATA_DIR = '/tmp/asentra-be03i3-pg';
const EMBEDDED_DATABASE = process.env.ASENTRA_USE_EMBEDDED_POSTGRES === 'true';

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

let pg: EmbeddedPostgres | null = null;
let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';

type Fixture = {
  clientId: string;
  buildingId: string;
  organizationId: string;
  departmentId: string;
  teamId: string;
  positionId: string;
};

before(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: DB_PORT,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query('CREATE DATABASE asentra_test');
  await admin.end();

  database = parseConfig(process.env).database;
  pool = await initDatabase(database);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, clients CASCADE');
  adminToken = await createAdminSession();
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (pg) await pg.stop();
  } finally {
    await rm(DATA_DIR, { recursive: true, force: true });
  }
  pool = null;
  database = null;
  pg = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool || !pg) {
    t.skip('embedded PostgreSQL test database is unavailable');
    return false;
  }
  return true;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

async function seedFixture(prefix: string): Promise<Fixture> {
  const client = await clientService.createClient({
    code: `${prefix}_CLI_${suffix()}`,
    name: `${prefix} Client`,
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `${prefix}_PROP_${suffix()}`,
    name: `${prefix} Property`,
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `${prefix}_BLD_${suffix()}`,
    name: `${prefix} Building`,
    timezone: 'Asia/Jakarta',
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `${prefix}_ORG_${suffix()}`,
    name: `${prefix} Org`,
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `${prefix}_DEP_${suffix()}`,
    name: `${prefix} Dept`,
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `${prefix}_TEAM_${suffix()}`,
    name: `${prefix} Team`,
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `${prefix}_POS_${suffix()}`,
    name: `${prefix} Position`,
  });

  return {
    clientId: client.id,
    buildingId: building.id,
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
  };
}

async function seedProfile(
  fixture: Fixture,
  options: {
    prefix: string;
    workforceType?: 'INTERNAL' | 'EXTERNAL';
    status?: 'ACTIVE' | 'INACTIVE';
    teamId?: string | null;
  },
) {
  return workforceService.createWorkforceProfile({
    organizationId: fixture.organizationId,
    departmentId: fixture.departmentId,
    teamId: options.teamId === undefined ? fixture.teamId : options.teamId,
    positionId: fixture.positionId,
    employeeCode: `${options.prefix}_EMP_${suffix()}`,
    fullName: `${options.prefix} Worker`,
    workforceType: options.workforceType ?? 'INTERNAL',
    status: options.status ?? 'ACTIVE',
  });
}

async function seedSkill(fixture: Fixture, prefix: string) {
  return skillService.createSkill({
    clientId: fixture.clientId,
    code: `${prefix}_SKL_${suffix()}`,
    name: `${prefix} Skill`,
    category: 'TECHNICAL',
  });
}

async function seedShift(fixture: Fixture, prefix: string) {
  return shiftService.createShift({
    clientId: fixture.clientId,
    buildingId: fixture.buildingId,
    code: `${prefix}_SHIFT_${suffix()}`,
    name: `${prefix} Shift`,
    startTime: '07:00:00',
    endTime: '15:00:00',
  });
}

describe('BE-03I3 workforce reporting isolation and validation', () => {
  it('enforces RBAC and returns 403 without workforce.read', async (t) => {
    if (!requireDatabase(t)) return;

    const noPermission = await api().get('/api/v1/workforce/reporting');
    assert.equal(noPermission.status, 401);

    const plain = await api()
      .get('/api/v1/workforce/reporting')
      .set({ Authorization: 'Bearer invalid-token' });
    assert.equal(plain.status, 401);
  });

  it('does not leak cross-client, sibling-building, unassigned, inactive, or ineffective data', async (t) => {
    if (!requireDatabase(t)) return;

    const a = await seedFixture('A');
    const b = await seedFixture('B');
    const admin = await getPool().query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permission_assignments rpa ON rpa.role_id = r.id
       JOIN permissions p ON p.id = rpa.permission_id
       WHERE p.code = 'workforce.read' LIMIT 1`,
    );
    await buildingAssignmentService.createAssignment(admin.rows[0].id, {
      buildingId: a.buildingId,
    });

    const internalA = await seedProfile(a, { prefix: 'AINT' });
    const inactiveA = await seedProfile(a, {
      prefix: 'AINACT',
      status: 'INACTIVE',
    });
    const externalA = await seedProfile(a, {
      prefix: 'AEXT',
      workforceType: 'EXTERNAL',
      teamId: null,
    });
    const unassignedA = await seedProfile(a, { prefix: 'AUN' });
    const internalB = await seedProfile(b, { prefix: 'BINT' });

    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: internalA.id,
      buildingId: a.buildingId,
    });
    // Historical/edge case: an assignment may point at a profile later
    // deactivated. Reporting must still exclude the inactive profile by
    // default. Insert directly because the write service intentionally blocks
    // new assignments to inactive profiles.
    await getPool().query(
      `INSERT INTO workforce_building_assignments
         (id, workforce_profile_id, building_id, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [randomUUID(), inactiveA.id, a.buildingId],
    );
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: internalB.id,
      buildingId: b.buildingId,
    });

    const inactiveAssignment =
      await workforceBuildingAssignmentService.assignBuildingToWorkforce({
        workforceProfileId: externalA.id,
        buildingId: a.buildingId,
      });
    await workforceBuildingAssignmentService.updateWorkforceBuildingAssignment(
      externalA.id,
      a.buildingId,
      { status: 'INACTIVE' },
    );
    assert.equal(inactiveAssignment.id, inactiveAssignment.id);

    const currentSkill = await seedSkill(a, 'CUR');
    const futureSkill = await seedSkill(a, 'FUT');
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: internalA.id,
      skillId: currentSkill.id,
      proficiencyLevel: 'ADVANCED',
    });
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: internalA.id,
      skillId: futureSkill.id,
      validFrom: new Date('2099-01-01T00:00:00.000Z'),
    });

    const currentShift = await seedShift(a, 'CUR');
    const inactiveShift = await seedShift(a, 'OLD');
    await workforceShiftService.assignShiftToWorkforce({
      workforceProfileId: internalA.id,
      shiftId: currentShift.id,
    });
    const oldShiftAssignment = await workforceShiftService.assignShiftToWorkforce({
      workforceProfileId: externalA.id,
      shiftId: inactiveShift.id,
    });
    await workforceShiftService.updateWorkforceShiftAssignment(
      externalA.id,
      inactiveShift.id,
      {
        effectiveUntil: new Date('2000-01-01T00:00:00.000Z'),
      },
    );
    assert.ok(oldShiftAssignment.id);

    const supervisor = await seedProfile(a, { prefix: 'ASUP' });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: supervisor.id,
      buildingId: a.buildingId,
    });
    await workforceReportingLineService.assignSupervisor({
      workforceProfileId: internalA.id,
      supervisorWorkforceProfileId: supervisor.id,
    });
    await workforceReportingLineService.assignSupervisor({
      workforceProfileId: unassignedA.id,
      supervisorWorkforceProfileId: internalA.id,
      effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
    });

    const response = await api()
      .get('/api/v1/workforce/reporting')
      .query({ organizationId: a.organizationId, limit: 50, page: 1 })
      .set(authHeaders());

    assert.equal(response.status, 200);
    const ids = response.body.data.map(
      (row: { profile: { id: string } }) => row.profile.id,
    );
    assert.deepEqual(ids, [internalA.id, supervisor.id]);
    assert.equal(response.body.meta.total, 2);
    assert.equal(response.body.meta.page, 1);
    assert.equal(response.body.meta.limit, 50);
    assert.ok(!ids.includes(internalB.id), 'cross-client Building B data leaked');
    assert.ok(!ids.includes(unassignedA.id), 'unassigned workforce leaked');
    assert.ok(!ids.includes(externalA.id), 'inactive assignment leaked');
    assert.ok(!ids.includes(inactiveA.id), 'inactive workforce leaked by default');

    const record = response.body.data.find(
      (row: { profile: { id: string } }) => row.profile.id === internalA.id,
    );
    assert.equal(record.profile.workforceType, 'INTERNAL');
    assert.equal(record.skills.length, 1);
    assert.equal(record.skills[0].skillId, currentSkill.id);
    assert.equal(record.shifts.length, 1);
    assert.equal(record.shifts[0].shiftId, currentShift.id);
    assert.equal(record.supervisor.workforceProfileId, supervisor.id);
    assert.equal(record.buildingAssignments[0].buildingId, a.buildingId);

    const externalOrgId = randomUUID();
    const externalFiltered = await api()
      .get('/api/v1/workforce/reporting')
      .query({ externalOrganizationId: externalOrgId, limit: 10 })
      .set(authHeaders());
    assert.equal(externalFiltered.status, 200);
    assert.deepEqual(externalFiltered.body.data, []);
    assert.equal(externalFiltered.body.meta.total, 0);
  });

  it('keeps pagination total and pages consistent under accessible-building scope', async (t) => {
    if (!requireDatabase(t)) return;

    const a = await seedFixture('PAG');
    const admin = await getPool().query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permission_assignments rpa ON rpa.role_id = r.id
       JOIN permissions p ON p.id = rpa.permission_id
       WHERE p.code = 'workforce.read' LIMIT 1`,
    );
    await buildingAssignmentService.createAssignment(admin.rows[0].id, {
      buildingId: a.buildingId,
    });

    for (let index = 0; index < 3; index += 1) {
      const profile = await seedProfile(a, { prefix: `PAG${index}` });
      await workforceBuildingAssignmentService.assignBuildingToWorkforce({
        workforceProfileId: profile.id,
        buildingId: a.buildingId,
      });
    }

    const page1 = await api()
      .get('/api/v1/workforce/reporting')
      .query({ organizationId: a.organizationId, page: 1, limit: 2 })
      .set(authHeaders());
    const page2 = await api()
      .get('/api/v1/workforce/reporting')
      .query({ organizationId: a.organizationId, page: 2, limit: 2 })
      .set(authHeaders());

    assert.equal(page1.status, 200);
    assert.equal(page2.status, 200);
    assert.equal(page1.body.data.length, 2);
    assert.equal(page2.body.data.length, 1);
    assert.equal(page1.body.meta.total, 3);
    assert.equal(page2.body.meta.total, 3);

    const page1Ids = page1.body.data.map(
      (row: { profile: { id: string } }) => row.profile.id,
    );
    const page2Ids = page2.body.data.map(
      (row: { profile: { id: string } }) => row.profile.id,
    );
    assert.equal(page1Ids.some((id: string) => page2Ids.includes(id)), false);
  });

  it('returns scoped detail only for accessible workforce and 404 otherwise', async (t) => {
    if (!requireDatabase(t)) return;

    const a = await seedFixture('DET');
    const b = await seedFixture('DETB');
    const admin = await getPool().query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN roles r ON r.id = ura.role_id
       JOIN role_permission_assignments rpa ON rpa.role_id = r.id
       JOIN permissions p ON p.id = rpa.permission_id
       WHERE p.code = 'workforce.read' LIMIT 1`,
    );
    await buildingAssignmentService.createAssignment(admin.rows[0].id, {
      buildingId: a.buildingId,
    });

    const visible = await seedProfile(a, { prefix: 'DETV' });
    const hidden = await seedProfile(b, { prefix: 'DETH' });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: visible.id,
      buildingId: a.buildingId,
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: hidden.id,
      buildingId: b.buildingId,
    });

    const ok = await api()
      .get(`/api/v1/workforce/reporting/${visible.id}`)
      .set(authHeaders());
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.profile.id, visible.id);

    const denied = await api()
      .get(`/api/v1/workforce/reporting/${hidden.id}`)
      .set(authHeaders());
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');

    const malformed = await api()
      .get('/api/v1/workforce/reporting/not-a-uuid')
      .set(authHeaders());
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');
  });
});
