import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
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
import { teamService } from '../src/modules/teams';
import { workforceService } from '../src/modules/workforce';
import { resolveMyTeamContext } from '../src/modules/mobile-my-team';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-25N — Mobile My Team focused validation.
 *
 * Proves the derivation contract for `GET /mobile/my-team`: the authenticated
 * user's own team and ACTIVE members are resolved from the linked BE-03C
 * Workforce Profile (`team_id`), the BE-03B Team hierarchy and the BE-02F/G
 * Client scope. Also proves the safety boundaries: authentication, no linked
 * profile, no team, inactive members excluded, and cross-Client isolation.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       workforce_profiles, teams, departments, organizations, positions,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'My team client',
  });
  const propertyA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propertyA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Other client',
  });

  const organization = await organizationService.createOrganization({
    clientId: clientA.id,
    code: `O_${suffix()}`,
    name: 'Organization A',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `D_${suffix()}`,
    name: 'Department A',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `P_${suffix()}`,
    name: 'Supervisor',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `T_${suffix()}`,
    name: 'Engineering Team',
  });

  const manager = await createAdminUser();
  await buildingAssignmentService.createAssignment(manager.userId, {
    buildingId: buildingA.id,
  });

  // The caller (supervisor) — linked profile inside the accessible client.
  const supervisorProfile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    userId: manager.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Supervisor One',
  });

  // Another ACTIVE team member (no linked user).
  const memberProfile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Member Two',
  });

  // An INACTIVE team member (must be excluded).
  const inactiveProfile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Inactive Member',
    status: 'INACTIVE',
  });

  // A second caller with a profile in a DIFFERENT client than their
  // accessible Buildings — must resolve to an empty context.
  const cross = await createAdminUser();
  await buildingAssignmentService.createAssignment(cross.userId, {
    buildingId: buildingA.id,
  });
  const orgC = await organizationService.createOrganization({
    clientId: clientC.id,
    code: `O_${suffix()}`,
    name: 'Organization C',
  });
  const deptC = await departmentService.createDepartment({
    organizationId: orgC.id,
    code: `D_${suffix()}`,
    name: 'Department C',
  });
  const posC = await positionService.createPosition({
    organizationId: orgC.id,
    code: `P_${suffix()}`,
    name: 'Worker C',
  });
  const teamC = await teamService.createTeam({
    departmentId: deptC.id,
    code: `T_${suffix()}`,
    name: 'Team C',
  });
  const crossProfile = await workforceService.createWorkforceProfile({
    organizationId: orgC.id,
    departmentId: deptC.id,
    teamId: teamC.id,
    positionId: posC.id,
    userId: cross.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Cross Client Worker',
  });

  // A caller with a linked profile but NO team.
  const noTeam = await createAdminUser();
  await buildingAssignmentService.createAssignment(noTeam.userId, {
    buildingId: buildingA.id,
  });
  const noTeamProfile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: null,
    positionId: position.id,
    userId: noTeam.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'No Team Worker',
  });

  return {
    clientA,
    organization,
    department,
    position,
    team,
    manager,
    supervisorProfile,
    memberProfile,
    inactiveProfile,
    cross,
    crossProfile,
    noTeam,
    noTeamProfile,
  };
}

describe('BE-25N mobile my team', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const response = await api().get('/api/v1/mobile/my-team');
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('returns an empty context for an authenticated user without a linked profile', async (t) => {
    if (!ready(t)) return;
    const token = await createPlainSession();
    const response = await api()
      .get('/api/v1/mobile/my-team')
      .set({ Authorization: `Bearer ${token}` });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.success);
    assert.equal(response.body.data.team, null);
    assert.equal(response.body.data.workforceProfile, null);
    assert.deepEqual(response.body.data.members, []);
  });

  it('derives the caller team with its authoritative hierarchy and ACTIVE members', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const context = await resolveMyTeamContext(f.manager.userId);
    assert.equal(context.workforceProfile?.id, f.supervisorProfile.id);
    assert.equal(context.workforceProfile?.employeeCode, f.supervisorProfile.employeeCode);

    assert.ok(context.team);
    assert.equal(context.team.id, f.team.id);
    assert.equal(context.team.code, f.team.code);
    assert.equal(context.team.name, f.team.name);
    assert.equal(context.team.status, 'ACTIVE');
    assert.equal(context.team.department.id, f.department.id);
    assert.equal(context.team.organization.id, f.organization.id);
    assert.equal(context.team.client.id, f.clientA.id);

    const memberIds = context.members.map((m) => m.id);
    assert.ok(memberIds.includes(f.supervisorProfile.id), 'caller is a member');
    assert.ok(memberIds.includes(f.memberProfile.id), 'other ACTIVE member present');
    assert.ok(
      !memberIds.includes(f.inactiveProfile.id),
      'INACTIVE member excluded',
    );

    const member = context.members.find((m) => m.id === f.memberProfile.id);
    assert.ok(member);
    assert.equal(member.status, 'ACTIVE');
    assert.equal(member.positionId, f.position.id);
    assert.equal(member.workforceType, 'INTERNAL');
    assert.equal(member.userId, null);
  });

  it('returns team null (not empty members) for a profile with no team', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const context = await resolveMyTeamContext(f.noTeam.userId);
    assert.equal(context.workforceProfile?.id, f.noTeamProfile.id);
    assert.equal(context.team, null);
    assert.deepEqual(context.members, []);
  });

  it('returns an empty context when the profile client is outside the accessible scope', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const context = await resolveMyTeamContext(f.cross.userId);
    assert.equal(context.workforceProfile?.id, f.crossProfile.id);
    assert.equal(context.team, null);
    assert.deepEqual(context.members, []);
  });
});
