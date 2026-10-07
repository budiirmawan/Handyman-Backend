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
import { externalWorkforceService } from '../src/modules/external-workforce';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { shiftService } from '../src/modules/shifts';
import { skillService } from '../src/modules/skills';
import { teamService } from '../src/modules/teams';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { workforceReportingService } from '../src/modules/workforce-reporting';
import { workforceReportingLineService } from '../src/modules/workforce-reporting-lines';
import { workforceService } from '../src/modules/workforce';
import { workforceShiftService } from '../src/modules/workforce-shifts';
import { workforceSkillService } from '../src/modules/workforce-skills';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

type Chain = {
  clientId: string;
  propertyId: string;
  buildingId: string;
  organizationId: string;
  departmentId: string;
  teamId: string;
  positionId: string;
};

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;

  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query('TRUNCATE users, roles, clients CASCADE');
  const admin = await createAdminUser();
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

function suffix(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

async function seedChain(): Promise<Chain> {
  const client = await clientService.createClient({
    code: `CLI_R_${suffix()}`,
    name: 'Reporting Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_R_${suffix()}`,
    name: 'Reporting Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD_R_${suffix()}`,
    name: 'Reporting Building',
    timezone: 'Asia/Jakarta',
  });
  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_R_${suffix()}`,
    name: 'Reporting Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_R_${suffix()}`,
    name: 'Reporting Department',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `TEAM_R_${suffix()}`,
    name: 'Reporting Team',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_R_${suffix()}`,
    name: 'Reporting Position',
  });

  return {
    clientId: client.id,
    propertyId: property.id,
    buildingId: building.id,
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
  };
}

async function seedProfile(
  chain: Chain,
  overrides: {
    fullName?: string;
    employeeCode?: string;
    workforceType?: 'INTERNAL' | 'OUTSOURCED' | 'CONTRACT' | 'EXTERNAL';
    teamId?: string | null;
    status?: 'ACTIVE' | 'INACTIVE';
  } = {},
) {
  return workforceService.createWorkforceProfile({
    organizationId: chain.organizationId,
    departmentId: chain.departmentId,
    teamId: overrides.teamId === undefined ? chain.teamId : overrides.teamId,
    positionId: chain.positionId,
    employeeCode: overrides.employeeCode ?? `EMP_${suffix()}`,
    fullName: overrides.fullName ?? 'Reporting Worker',
    workforceType: overrides.workforceType ?? 'INTERNAL',
    status: overrides.status ?? 'ACTIVE',
  });
}

describe('BE-03I1 workforce reporting read model', () => {
  it('rejects unscoped reporting reads to preserve client/data isolation', async () => {
    await assert.rejects(
      workforceReportingService.listWorkforceReporting(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /requires a client or accessible-building scope/);
        return true;
      },
    );
  });

  it('assembles all reporting dimensions for one workforce profile', async (t) => {
    if (!requireDatabase(t)) return;

    const chain = await seedChain();
    const profile = await seedProfile(chain, { fullName: 'Complete Worker' });
    const supervisorProfile = await seedProfile(chain, {
      fullName: 'Supervisor Worker',
      employeeCode: `SUP_${suffix()}`,
    });
    const directReport = await seedProfile(chain, {
      fullName: 'Direct Report',
      employeeCode: `DR_${suffix()}`,
    });

    const skill = await skillService.createSkill({
      clientId: chain.clientId,
      code: `SKL_${suffix()}`,
      name: 'HVAC',
      category: 'TECHNICAL',
    });
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: profile.id,
      skillId: skill.id,
      proficiencyLevel: 'ADVANCED',
    });

    const shift = await shiftService.createShift({
      clientId: chain.clientId,
      buildingId: chain.buildingId,
      code: `MOR_${suffix()}`,
      name: 'Morning',
      startTime: '07:00:00',
      endTime: '15:00:00',
    });
    await workforceShiftService.assignShiftToWorkforce({
      workforceProfileId: profile.id,
      shiftId: shift.id,
    });

    await workforceReportingLineService.assignSupervisor({
      workforceProfileId: profile.id,
      supervisorWorkforceProfileId: supervisorProfile.id,
    });
    await workforceReportingLineService.assignSupervisor({
      workforceProfileId: directReport.id,
      supervisorWorkforceProfileId: profile.id,
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: directReport.id,
      buildingId: chain.buildingId,
    });

    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: chain.buildingId,
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: chain.buildingId,
    });

    const externalOrgId = await pool!.query<{ id: string }>(
      `INSERT INTO external_organizations (id, client_id, code, name, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING id`,
      [randomUUID(), chain.clientId, `VND_${suffix()}`, 'Vendor Co'],
    ).then((result) => result.rows[0].id);
    const externalProfile = await seedProfile(chain, {
      workforceType: 'EXTERNAL',
      employeeCode: `EXT_${suffix()}`,
      fullName: 'Vendor Worker',
      teamId: null,
    });
    await externalWorkforceService.createExternalWorkforceLink({
      workforceProfileId: externalProfile.id,
      externalOrganizationId: externalOrgId,
      externalPersonnelCode: 'V-001',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: externalProfile.id,
      buildingId: chain.buildingId,
    });

    const [record, externalRecord] = await Promise.all([
      workforceReportingService.getWorkforceReporting(profile.id, {
        clientId: chain.clientId,
        accessibleBuildingIds: [chain.buildingId],
      }),
      workforceReportingService.getWorkforceReporting(externalProfile.id, {
        clientId: chain.clientId,
        accessibleBuildingIds: [chain.buildingId],
      }),
    ]);

    assert.ok(record);
    assert.equal(record.client.id, chain.clientId);
    assert.equal(record.organization.id, chain.organizationId);
    assert.equal(record.department.id, chain.departmentId);
    assert.equal(record.team?.id, chain.teamId);
    assert.equal(record.position.id, chain.positionId);
    assert.equal(record.profile.id, profile.id);
    assert.equal(record.profile.fullName, 'Complete Worker');
    assert.equal(record.skills[0]?.skillId, skill.id);
    assert.equal(record.skills[0]?.proficiencyLevel, 'ADVANCED');
    assert.equal(record.shifts[0]?.shiftId, shift.id);
    assert.equal(record.shifts[0]?.buildingId, chain.buildingId);
    assert.equal(record.supervisor?.workforceProfileId, supervisorProfile.id);
    assert.equal(record.directReports[0]?.workforceProfileId, directReport.id);
    assert.equal(record.buildingAssignments[0]?.buildingId, chain.buildingId);
    assert.equal(
      record.buildingAssignments[0]?.propertyId,
      chain.propertyId,
    );

    assert.ok(externalRecord);
    assert.equal(externalRecord.profile.workforceType, 'EXTERNAL');
    assert.equal(externalRecord.team, null);
    assert.equal(
      externalRecord.externalAffiliations[0]?.externalOrganizationId,
      externalOrgId,
    );
    assert.equal(
      externalRecord.externalAffiliations[0]?.externalPersonnelCode,
      'V-001',
    );
  });

  it('preserves client isolation through explicit client and building scopes', async (t) => {
    if (!requireDatabase(t)) return;

    const chainA = await seedChain();
    const chainB = await seedChain();
    const profileA = await seedProfile(chainA, { employeeCode: `A_${suffix()}` });
    await seedProfile(chainB, { employeeCode: `B_${suffix()}` });

    const clientRows = await workforceReportingService.listWorkforceReporting({
      clientId: chainA.clientId,
    });
    assert.ok(clientRows.some((row) => row.profile.id === profileA.id));
    assert.ok(
      clientRows.every((row) => row.client.id === chainA.clientId),
    );

    const buildingRows = await workforceReportingService.listWorkforceReporting({
      accessibleBuildingIds: [chainB.buildingId],
    });
    assert.deepEqual(buildingRows, []);

    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profileA.id,
      buildingId: chainA.buildingId,
    });
    const accessibleRows = await workforceReportingService.listWorkforceReporting({
      accessibleBuildingIds: [chainA.buildingId],
    });
    assert.equal(accessibleRows.length, 1);
    assert.equal(accessibleRows[0]?.profile.id, profileA.id);
    assert.equal(accessibleRows[0]?.client.id, chainA.clientId);
  });

  it('excludes inactive and time-ineffective associations unless requested or in force', async (t) => {
    if (!requireDatabase(t)) return;

    const chain = await seedChain();
    const activeProfile = await seedProfile(chain, {
      employeeCode: `ACTIVE_${suffix()}`,
    });
    const inactiveProfile = await seedProfile(chain, {
      employeeCode: `INACTIVE_${suffix()}`,
      status: 'INACTIVE',
    });

    const activeSkill = await skillService.createSkill({
      clientId: chain.clientId,
      code: `SKA_${suffix()}`,
      name: 'Active Skill',
    });
    const futureSkill = await skillService.createSkill({
      clientId: chain.clientId,
      code: `SKF_${suffix()}`,
      name: 'Future Skill',
    });
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: activeProfile.id,
      skillId: activeSkill.id,
    });
    await workforceSkillService.assignSkillToWorkforce({
      workforceProfileId: activeProfile.id,
      skillId: futureSkill.id,
      validFrom: new Date('2099-01-01T00:00:00.000Z'),
    });

    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: activeProfile.id,
      buildingId: chain.buildingId,
    });

    const rows = await workforceReportingService.listWorkforceReporting({
      clientId: chain.clientId,
      accessibleBuildingIds: [chain.buildingId],
      asOf: new Date('2026-08-14T00:00:00.000Z'),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.profile.id, activeProfile.id);
    assert.equal(rows[0]?.skills.length, 1);
    assert.equal(rows[0]?.skills[0]?.skillId, activeSkill.id);

    const inactiveRows = await workforceReportingService.listWorkforceReporting({
      clientId: chain.clientId,
      includeInactive: true,
      accessibleBuildingIds: [chain.buildingId],
    });
    assert.equal(
      inactiveRows.some((row) => row.profile.id === inactiveProfile.id),
      false,
      'An inactive profile without an accessible effective building assignment remains hidden from building scope',
    );

    const inactiveInClient = await workforceReportingService.listWorkforceReporting({
      clientId: chain.clientId,
      includeInactive: true,
    });
    assert.ok(
      inactiveInClient.some((row) => row.profile.id === inactiveProfile.id),
    );
  });
});
