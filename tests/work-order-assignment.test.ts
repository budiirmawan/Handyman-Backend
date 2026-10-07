import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { positionService } from '../src/modules/positions';
import { teamService } from '../src/modules/teams';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { vendorService } from '../src/modules/vendors';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';
import { closeWorkOrderVia } from './helpers/work-order-close';

/**
 * BE-08E — Work Order Workforce / Vendor Assignment focused tests.
 *
 * Covers only assignment to existing Workforce / Team / Vendor / Vendor
 * Workforce: assign each type, unknown assignee, Vendor/Vendor Workforce
 * mismatch, inactive assignee, inactive Vendor relationship, duplicate
 * assignment, reassign, cross-Client / cross-Building rejection, isolation,
 * and RBAC. Automatic assignment, skill matching, execution, evidence,
 * completion, verification, and audit/history are deliberately absent.
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
    `TRUNCATE work_order_assignments, work_orders, work_requests,
      vendor_workforce_bindings, vendor_building_relationships, vendors,
      workforce_building_assignments, workforce_profiles, teams, positions,
      departments, organizations, users, roles, clients, properties,
      buildings CASCADE`,
  );
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

async function createClient() {
  return clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Assignment Client',
  });
}

async function createBuildingFor(clientId: string, assignTo?: string | null) {
  const property = await propertyService.createProperty({
    clientId,
    code: `PROP_${suffix()}`,
    name: 'Assignment Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Assignment Building',
  });
  if (assignTo) {
    await buildingAssignmentService.createAssignment(assignTo, {
      buildingId: building.id,
    });
  }
  return building;
}

async function createOrgChain(clientId: string) {
  const organization = await organizationService.createOrganization({
    clientId,
    code: `ORG_${suffix()}`,
    name: 'Assignment Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Assignment Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    code: `POS_${suffix()}`,
    name: 'Assignment Position',
  });
  return { organization, department, position };
}

async function createTeam(departmentId: string) {
  return teamService.createTeam({
    departmentId,
    code: `T_${suffix()}`,
    name: 'Assignment Team',
  });
}

async function createWorkforce(
  chain: Awaited<ReturnType<typeof createOrgChain>>,
  workforceType: 'INTERNAL' | 'EXTERNAL' = 'INTERNAL',
) {
  return workforceService.createWorkforceProfile({
    organizationId: chain.organization.id,
    departmentId: chain.department.id,
    positionId: chain.position.id,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Assignment Worker',
    workforceType,
  });
}

async function createWorkOrderVia(
  buildingId: string,
  clientId: string,
  status = 'OPEN',
) {
  const wo = await workOrderService.createWorkOrder({
    clientId,
    buildingId,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Assignment Work Order',
    workType: 'REPAIR',
    createdByUserId: adminUserId,
  });
  if (status === 'CLOSED') {
    // Reach COMPLETED, then close through the BE-08I verification flow.
    for (const s of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']) {
      const r = await api()
        .patch(`/api/v1/work-orders/${wo.id}/status`)
        .set(authHeaders())
        .send({ status: s });
      assert.equal(r.status, 200, `transition to ${s} failed`);
    }
    const close = await closeWorkOrderVia(wo.id, adminToken);
    assert.equal(close.status, 200, `close failed: ${JSON.stringify(close.body)}`);
  } else if (status !== 'OPEN') {
    const r = await api()
      .patch(`/api/v1/work-orders/${wo.id}/status`)
      .set(authHeaders())
      .send({ status });
    assert.equal(r.status, 200, `transition to ${status} failed`);
  }
  return wo;
}

async function assignVia(workOrderId: string, body: object, token = adminToken) {
  return api()
    .post(`/api/v1/work-orders/${workOrderId}/assignments`)
    .set(authHeaders(token))
    .send(body);
}

describe('assign workforce', () => {
  it('assigns an internal workforce profile placed in the building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const profile = await createWorkforce(chain);
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: building.id,
    });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: profile.id,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.assigneeType, 'WORKFORCE');
    assert.equal(response.body.data.workforceProfileId, profile.id);
    assert.equal(response.body.data.status, 'ACTIVE');
  });

  it('rejects a workforce not placed in the work order building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const profile = await createWorkforce(chain);
    // No building placement for this profile.
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: profile.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_ASSIGNMENT_BUILDING_MISMATCH');
  });

  it('rejects an inactive workforce', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const profile = await createWorkforce(chain);
    await workforceService.updateWorkforceProfile(profile.id, { status: 'INACTIVE' });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: profile.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORKFORCE_PROFILE_INACTIVE');
  });
});

describe('assign team', () => {
  it('assigns an active team of the same client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'TEAM',
      teamId: team.id,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.assigneeType, 'TEAM');
    assert.equal(response.body.data.teamId, team.id);
  });

  it('rejects an inactive team', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    await teamService.updateTeam(team.id, { status: 'INACTIVE' });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'TEAM',
      teamId: team.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'TEAM_INACTIVE');
  });
});

describe('assign vendor', () => {
  it('assigns an active vendor related to the building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Assignment Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'VENDOR',
      vendorId: vendor.id,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.assigneeType, 'VENDOR');
    assert.equal(response.body.data.vendorId, vendor.id);
  });

  it('rejects a vendor without an active relationship to the building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Unrelated Vendor',
    });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'VENDOR',
      vendorId: vendor.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_ASSIGNMENT_BUILDING_MISMATCH');
  });
});

describe('assign vendor workforce', () => {
  it('assigns a workforce profile bound to the selected vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Assignment Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const external = await createWorkforce(chain, 'EXTERNAL');
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: vendor.id,
      workforceProfileId: external.id,
      vendorPersonnelCode: `VP-${suffix()}`,
    });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'VENDOR_WORKFORCE',
      vendorId: vendor.id,
      workforceProfileId: external.id,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.assigneeType, 'VENDOR_WORKFORCE');
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.workforceProfileId, external.id);
  });

  it('rejects a workforce profile not bound to the vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const vendor = await vendorService.createVendor({
      clientId: client.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Assignment Vendor',
    });
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: building.id,
    });
    const external = await createWorkforce(chain, 'EXTERNAL');
    // Not bound to this vendor.
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'VENDOR_WORKFORCE',
      vendorId: vendor.id,
      workforceProfileId: external.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'WORK_ORDER_ASSIGNMENT_VENDOR_WORKFORCE_MISMATCH',
    );
  });
});

describe('validation and lifecycle', () => {
  it('rejects an unknown assignee', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORKFORCE_PROFILE_NOT_FOUND');
  });

  it('rejects an unknown work order', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await assignVia(randomUUID(), {
      assigneeType: 'TEAM',
      teamId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'WORK_ORDER_NOT_FOUND');
  });

  it('rejects assignment in a terminal work order state', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id, 'CLOSED');

    const response = await assignVia(wo.id, {
      assigneeType: 'TEAM',
      teamId: team.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_ASSIGNMENT_INVALID_STATE');
  });

  it('rejects a duplicate active assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const first = await assignVia(wo.id, { assigneeType: 'TEAM', teamId: team.id });
    assert.equal(first.status, 201);

    const second = await assignVia(wo.id, { assigneeType: 'TEAM', teamId: team.id });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'WORK_ORDER_ASSIGNMENT_ALREADY_ASSIGNED');
  });
});

describe('reassign and deactivate', () => {
  it('reassigns the work order to a new assignee', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const teamA = await createTeam(chain.department.id);
    const teamB = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const first = await assignVia(wo.id, { assigneeType: 'TEAM', teamId: teamA.id });
    assert.equal(first.status, 201);

    const list = await api()
      .get(`/api/v1/work-orders/${wo.id}/assignments`)
      .set(authHeaders());
    assert.equal(list.body.data.length, 1);

    const reassigned = await api()
      .patch(`/api/v1/work-orders/${wo.id}/assignments/${first.body.data.id}`)
      .set(authHeaders())
      .send({ assigneeType: 'TEAM', teamId: teamB.id });
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.data.teamId, teamB.id);

    const after = await api()
      .get(`/api/v1/work-orders/${wo.id}/assignments`)
      .set(authHeaders());
    // One historical + one active.
    assert.equal(after.body.data.length, 2);
    const active = after.body.data.filter((a: { status: string }) => a.status === 'ACTIVE');
    assert.equal(active.length, 1);
    assert.equal(active[0].teamId, teamB.id);
  });

  it('deactivates the current assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const first = await assignVia(wo.id, { assigneeType: 'TEAM', teamId: team.id });
    assert.equal(first.status, 201);

    const deactivated = await api()
      .patch(`/api/v1/work-orders/${wo.id}/assignments/${first.body.data.id}`)
      .set(authHeaders())
      .send({ status: 'INACTIVE' });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.data.status, 'INACTIVE');

    const current = await api()
      .get(`/api/v1/work-orders/${wo.id}/assignments/current`)
      .set(authHeaders());
    assert.equal(current.body.data, null);
  });
});

describe('RBAC and isolation', () => {
  it('rejects a cross-client workforce', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    // Workforce in a different client.
    const otherClient = await createClient();
    const otherChain = await createOrgChain(otherClient.id);
    const profile = await createWorkforce(otherChain);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'WORKFORCE',
      workforceProfileId: profile.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_ASSIGNMENT_CLIENT_MISMATCH');
  });

  it('rejects a cross-client vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const otherClient = await createClient();
    const otherVendor = await vendorService.createVendor({
      clientId: otherClient.id,
      vendorCode: `VND_${suffix()}`,
      vendorName: 'Foreign Vendor',
    });
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, {
      assigneeType: 'VENDOR',
      vendorId: otherVendor.id,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'WORK_ORDER_ASSIGNMENT_CLIENT_MISMATCH');
  });

  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await api()
      .post(`/api/v1/work-orders/${wo.id}/assignments`)
      .send({ assigneeType: 'TEAM', teamId: team.id });
    assert.equal(response.status, 401);
  });

  it('denies a user without work order permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const response = await assignVia(wo.id, { assigneeType: 'TEAM', teamId: team.id }, plainToken);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies assignment across the client isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const client = await createClient();
    const building = await createBuildingFor(client.id, adminUserId);
    const chain = await createOrgChain(client.id);
    const team = await createTeam(chain.department.id);
    const wo = await createWorkOrderVia(building.id, client.id);

    const outsider = await createAdminUser();
    const response = await assignVia(
      wo.id,
      { assigneeType: 'TEAM', teamId: team.id },
      outsider.token,
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});
