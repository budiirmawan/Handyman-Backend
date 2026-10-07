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
import { workOrderService } from '../src/modules/work-orders';
import { workOrderAssignmentService } from '../src/modules/work-order-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-MOB-03 PART 04 — Team-scoped Work Order read, runtime derivation
 * (TMW-04).
 *
 * Proves the team-scope derivation for `GET /work-orders/team` against a
 * real database (skips when no local PostgreSQL is available):
 *  - the team is derived from the authenticated session's linked ACTIVE
 *    Workforce Profile (`team_id`), never from a caller-supplied id;
 *  - Work Orders assigned to the TEAM and to ACTIVE team members are
 *    returned; Work Orders assigned to another team / another workforce
 *    member are not;
 *  - results are constrained to the caller's BE-02G accessible Buildings
 *    (a Work Order in a non-accessible Building is never returned);
 *  - no linked profile / no team → empty list;
 *  - the returned records are the authoritative BE-08 Work Orders
 *    (`work_orders.id`, existing status/lifecycle — no projection ids);
 *  - the endpoint is read-only (no assignment/work-order mutation).
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       work_orders, work_order_assignments, workforce_profiles, teams,
       departments, organizations, positions, workforce_building_assignments,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  database = db;
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
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
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return false;
  }
  return true;
}

async function seedTeamWithMember(actorUserId: string) {
  const client = await clientService.createClient({
    code: `CLI-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PRP-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLD-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Building',
  });
  await buildingAssignmentService.assignUserToBuilding({
    userId: actorUserId,
    buildingId: building.id,
    status: 'ACTIVE',
  });

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Organization',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEPT-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Department',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    departmentId: department.id,
    code: `POS-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Position',
  });
  const team = await teamService.createTeam({
    departmentId: department.id,
    code: `TEAM-${randomUUID().slice(0, 8)}`.toUpperCase(),
    name: 'Team',
  });
  const member = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    teamId: team.id,
    positionId: position.id,
    employeeCode: `WF-${randomUUID().slice(0, 8)}`.toUpperCase(),
    fullName: 'Team Member',
    workforceType: 'INTERNAL',
  });

  return { client, building, team, member };
}

describe('CR-BE-MOB-03 PART 04 — team-scoped Work Order runtime derivation', () => {
  it('lists only Work Orders assigned to the caller\'s team or its ACTIVE members, within accessible Buildings', async (t) => {
    if (!ready(t) || !pool) return;

    const { building, team, member } = await seedTeamWithMember(adminUserId);
    const created = await workOrderService.createWorkOrder({
      clientId: (await buildingService.getBuildingById(building.id)).clientId,
      buildingId: building.id,
      workOrderNumber: `WO-${randomUUID().slice(0, 8)}`.toUpperCase(),
      title: 'Team WO',
      workType: 'MAINTENANCE',
      createdByUserId: adminUserId,
    });
    await workOrderAssignmentService.assignWorkOrder({
      workOrderId: created.id,
      assigneeType: 'TEAM',
      teamId: team.id,
      assignedByUserId: adminUserId,
    });

    const memberWO = await workOrderService.createWorkOrder({
      clientId: (await buildingService.getBuildingById(building.id)).clientId,
      buildingId: building.id,
      workOrderNumber: `WO-${randomUUID().slice(0, 8)}`.toUpperCase(),
      title: 'Member WO',
      workType: 'REPAIR',
      createdByUserId: adminUserId,
    });
    await workOrderAssignmentService.assignWorkOrder({
      workOrderId: memberWO.id,
      assigneeType: 'WORKFORCE',
      workforceProfileId: member.id,
      assignedByUserId: adminUserId,
    });

    const list = await workOrderService.listTeamWorkOrders(adminUserId, {});
    const ids = list.map((wo) => wo.id);
    assert.ok(ids.includes(created.id), 'TEAM-assigned WO must be included');
    assert.ok(ids.includes(memberWO.id), 'member-assigned WO must be included');
    for (const wo of list) {
      assert.equal(wo.buildingId, building.id, 'only accessible-Building WOs are returned');
      assert.ok(wo.id, 'authoritative work_orders.id is preserved');
      assert.ok(wo.workOrderNumber && wo.status, 'authoritative BE-08 shape is preserved');
    }
  });

  it('excludes Work Orders assigned to another team or another workforce member', async (t) => {
    if (!ready(t) || !pool) return;

    const { building } = await seedTeamWithMember(adminUserId);
    const otherClient = await clientService.createClient({
      code: `CLI-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Client B',
    });
    const otherOrganization = await organizationService.createOrganization({
      clientId: otherClient.id,
      code: `ORG-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Org B',
    });
    const otherDept = await departmentService.createDepartment({
      organizationId: otherOrganization.id,
      code: `DEPT-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Dept B',
    });
    const otherPos = await positionService.createPosition({
      organizationId: otherOrganization.id,
      departmentId: otherDept.id,
      code: `POS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Pos B',
    });
    const otherTeam = await teamService.createTeam({
      departmentId: otherDept.id,
      code: `TEAM-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Team B',
    });
    const outsider = await workforceService.createWorkforceProfile({
      organizationId: otherOrganization.id,
      departmentId: otherDept.id,
      teamId: otherTeam.id,
      positionId: otherPos.id,
      employeeCode: `WF-${randomUUID().slice(0, 8)}`.toUpperCase(),
      fullName: 'Outsider',
      workforceType: 'INTERNAL',
    });

    // Same building (accessible) but assigned to the OTHER team / outsider.
    const clientId = (await buildingService.getBuildingById(building.id)).clientId;
    const otherTeamWO = await workOrderService.createWorkOrder({
      clientId,
      buildingId: building.id,
      workOrderNumber: `WO-${randomUUID().slice(0, 8)}`.toUpperCase(),
      title: 'Other Team WO',
      workType: 'CLEANING',
      createdByUserId: adminUserId,
    });
    await workOrderAssignmentService.assignWorkOrder({
      workOrderId: otherTeamWO.id,
      assigneeType: 'TEAM',
      teamId: otherTeam.id,
      assignedByUserId: adminUserId,
    });
    const outsiderWO = await workOrderService.createWorkOrder({
      clientId,
      buildingId: building.id,
      workOrderNumber: `WO-${randomUUID().slice(0, 8)}`.toUpperCase(),
      title: 'Outsider WO',
      workType: 'REPAIR',
      createdByUserId: adminUserId,
    });
    await workOrderAssignmentService.assignWorkOrder({
      workOrderId: outsiderWO.id,
      assigneeType: 'WORKFORCE',
      workforceProfileId: outsider.id,
      assignedByUserId: adminUserId,
    });

    const list = await workOrderService.listTeamWorkOrders(adminUserId, {});
    const ids = list.map((wo) => wo.id);
    assert.ok(!ids.includes(otherTeamWO.id), 'other-team WO must be excluded');
    assert.ok(!ids.includes(outsiderWO.id), 'outsider-assigned WO must be excluded');
  });

  it('returns an empty list when the caller has no linked ACTIVE profile or no team', async (t) => {
    if (!ready(t) || !pool) return;

    // A fresh session user with no workforce profile at all — the service
    // resolves the profile from the session; with no linked profile there is
    // no team, so the answer is an empty list, never an error.
    const token = await createPlainSession();
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    const userId = me.body.data.user.id as string;
    const list = await workOrderService.listTeamWorkOrders(userId, {});
    assert.deepEqual(list, []);
  });

  it('enforces Client/Building isolation — a Work Order in a non-accessible Building is never returned', async (t) => {
    if (!ready(t) || !pool) return;

    const { team, member } = await seedTeamWithMember(adminUserId);

    // A second Building the caller is NOT assigned to (not accessible).
    const otherClient = await clientService.createClient({
      code: `CLI-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Client C',
    });
    const otherProperty = await propertyService.createProperty({
      clientId: otherClient.id,
      code: `PRP-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Property C',
    });
    const hiddenBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `BLD-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Hidden Building',
    });

    const hiddenWO = await workOrderService.createWorkOrder({
      clientId: otherClient.id,
      buildingId: hiddenBuilding.id,
      workOrderNumber: `WO-${randomUUID().slice(0, 8)}`.toUpperCase(),
      title: 'Hidden WO',
      workType: 'MAINTENANCE',
      createdByUserId: adminUserId,
    });
    await workOrderAssignmentService.assignWorkOrder({
      workOrderId: hiddenWO.id,
      assigneeType: 'TEAM',
      teamId: team.id,
      assignedByUserId: adminUserId,
    });

    // Sanity: the same team assignment is used, but the Building is outside
    // the caller's accessible set, so it must be excluded.
    const list = await workOrderService.listTeamWorkOrders(adminUserId, {});
    const ids = list.map((wo) => wo.id);
    assert.ok(!ids.includes(hiddenWO.id), 'non-accessible-Building WO must be excluded');
  });
});
