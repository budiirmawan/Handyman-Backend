import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-18D — Tenant Meter focused validation.
 *
 * Covers only this PART: assigning an existing BE-18A Meter to an existing
 * BE-14A Tenant Company at an existing BE-04 Space, getting an assignment,
 * listing by Meter / Tenant / Space, resolving the current tenant context,
 * updating and ending an assignment, plus the guard rails — invalid meter,
 * invalid tenant/space, tenant/space mismatch, conflicting active assignment,
 * effective date validation, history preservation, RBAC and
 * Client / Building isolation.
 *
 * BE-18B utility configuration stays opt-in (no configuration is created
 * here) and BE-18C Main/Sub hierarchy is untouched. Meter Reading is out of
 * scope and is deliberately not exercised.
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
    `TRUNCATE utility_meter_tenant_assignments, utility_meter_hierarchies,
       utility_type_uoms, utility_type_configurations, utility_meters,
       units_of_measure, tenant_space_relationships, tenant_pics,
       tenant_companies, functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties, users, roles,
       permissions, role_permission_assignments, user_role_assignments,
       clients CASCADE`,
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

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });

async function createUom(clientId: string) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/uoms`)
    .set(auth())
    .send({
      code: `UOM_${suffix()}`,
      name: 'Measurement unit',
      symbol: 'kWh',
      category: 'ENERGY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id as string;
}

/** Client → Property → Building → Floor → Area → Room → Space (BE-04 chain). */
async function createStructure(options: { assignUserId?: string | null } = {}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Utility Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Utility Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Utility Building',
  });
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `FL_${suffix()}`,
    name: 'Ground floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `AR_${suffix()}`,
    name: 'Retail area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `RM_${suffix()}`,
    name: 'Unit room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Tenant unit',
  });

  const assignUserId =
    options.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  const uomId = await createUom(client.id);

  return { client, property, building, floor, area, room, space, uomId };
}

/** Adds another Space to the same Building (own Room under the same Area). */
async function addSpace(fixture: { area: { id: string } }) {
  const room = await roomService.createRoom({
    areaId: fixture.area.id,
    code: `RM_${suffix()}`,
    name: 'Second unit room',
  });
  return spaceService.createSpace({
    roomId: room.id,
    code: `SP_${suffix()}`,
    name: 'Second tenant unit',
  });
}

type Fixture = Awaited<ReturnType<typeof createStructure>>;

/** Registers a BE-18A Meter — BE-18D always reuses existing meters. */
async function createMeter(
  fixture: Fixture,
  options: { status?: 'ACTIVE' | 'INACTIVE'; buildingId?: string } = {},
) {
  const created = await api()
    .post(
      `/api/v1/buildings/${options.buildingId ?? fixture.building.id}/utility-meters`,
    )
    .set(auth())
    .send({
      code: `MTR_${suffix()}`,
      name: 'Tenant meter',
      utilityType: 'ELECTRICITY',
      uomId: fixture.uomId,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  if (options.status === 'INACTIVE') {
    const patched = await api()
      .patch(`/api/v1/utility/meters/${created.body.data.id}/status`)
      .set(auth())
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }
  return created.body.data;
}

/** BE-14A Tenant Company. */
async function createTenantCompany(clientId: string) {
  const created = await api()
    .post(`/api/v1/clients/${clientId}/tenant-companies`)
    .set(auth())
    .send({ tenantCode: `TNT_${suffix()}`, tenantName: 'Tenant Company' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data as { id: string };
}

/** BE-14C tenancy — the authority BE-18D validates the space against. */
async function leaseSpace(
  tenantCompanyId: string,
  buildingId: string,
  spaceId: string,
) {
  const created = await api()
    .post(`/api/v1/tenant-companies/${tenantCompanyId}/spaces`)
    .set(auth())
    .send({ buildingId, spaceId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data;
}

/** Ends a BE-14C tenancy so the Space can be leased to the next tenant. */
async function endLease(tenancyId: string) {
  const ended = await api()
    .patch(`/api/v1/tenant-space-relationships/${tenancyId}`)
    .set(auth())
    .send({ status: 'INACTIVE' });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
}

/** A Meter, a Tenant, and a BE-14C tenancy binding them to one Space. */
async function tenantScenario() {
  const fixture = await createStructure();
  const meter = await createMeter(fixture);
  const tenant = await createTenantCompany(fixture.client.id);
  const tenancy = await leaseSpace(tenant.id, fixture.building.id, fixture.space.id);
  return { fixture, meter, tenant, tenancy };
}

async function assign(
  meterId: string,
  body: Record<string, unknown>,
  token = adminToken,
) {
  return api()
    .post(`/api/v1/utility/meters/${meterId}/tenant-assignments`)
    .set(auth(token))
    .send(body);
}

describe('BE-18D tenant meter — valid assignment', () => {
  it('assigns an existing meter to a tenant at a leased space', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    const created = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const assignment = created.body.data;
    assert.equal(assignment.meterId, meter.id);
    assert.equal(assignment.tenantCompanyId, tenant.id);
    assert.equal(assignment.spaceId, fixture.space.id);
    assert.equal(assignment.status, 'ACTIVE');
    assert.equal(assignment.effectiveFrom, '2026-01-01T00:00:00.000Z');
    assert.equal(assignment.effectiveUntil, null);
    // Client / Building context is derived from the meter, never supplied.
    assert.equal(assignment.clientId, fixture.client.id);
    assert.equal(assignment.buildingId, fixture.building.id);
    // References are resolved, never duplicated into a tenant meter master.
    assert.equal(assignment.meter.code, meter.code);
    assert.equal(assignment.tenantCompany.id, tenant.id);
    assert.equal(assignment.space.id, fixture.space.id);

    const fetched = await api()
      .get(`/api/v1/utility/meter-tenant-assignments/${assignment.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.id, assignment.id);
  });

  it('resolves the current tenant meter context and returns null when unassigned', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const unassignedMeter = await createMeter(fixture);

    const before = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant`)
      .set(auth());
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.data, null);

    assert.equal(
      (
        await assign(meter.id, {
          tenantCompanyId: tenant.id,
          spaceId: fixture.space.id,
        })
      ).status,
      201,
    );

    const resolved = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant`)
      .set(auth());
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.tenantCompanyId, tenant.id);
    assert.equal(resolved.body.data.spaceId, fixture.space.id);

    // A landlord / common-area meter simply has no tenant — not an error.
    const stillNull = await api()
      .get(`/api/v1/utility/meters/${unassignedMeter.id}/tenant`)
      .set(auth());
    assert.equal(stillNull.status, 200);
    assert.equal(stillNull.body.data, null);
  });

  it('lists assignments by meter, tenant, and space', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const secondMeter = await createMeter(fixture);

    assert.equal(
      (
        await assign(meter.id, {
          tenantCompanyId: tenant.id,
          spaceId: fixture.space.id,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await assign(secondMeter.id, {
          tenantCompanyId: tenant.id,
          spaceId: fixture.space.id,
        })
      ).status,
      201,
    );

    const byMeter = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth());
    assert.equal(byMeter.status, 200, JSON.stringify(byMeter.body));
    assert.equal(byMeter.body.data.length, 1);
    assert.equal(byMeter.body.data[0].meterId, meter.id);

    // Two meters can serve the same tenant at the same space.
    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${tenant.id}/utility-meters`)
      .set(auth());
    assert.equal(byTenant.status, 200, JSON.stringify(byTenant.body));
    assert.equal(byTenant.body.data.length, 2);

    const bySpace = await api()
      .get(`/api/v1/spaces/${fixture.space.id}/utility-meters`)
      .set(auth());
    assert.equal(bySpace.status, 200, JSON.stringify(bySpace.body));
    assert.equal(bySpace.body.data.length, 2);

    const activeOnly = await api()
      .get(`/api/v1/tenant-companies/${tenant.id}/utility-meters?status=ACTIVE`)
      .set(auth());
    assert.equal(activeOnly.body.data.length, 2);
  });

  it('does not require any BE-18B utility configuration', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    const configured = await api()
      .get(`/api/v1/clients/${fixture.client.id}/utility-type-configurations`)
      .set(auth());
    assert.equal(configured.body.data.length, 0);

    const created = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  });
});

describe('BE-18D tenant meter — invalid references', () => {
  it('rejects an invalid meter', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, tenant } = await tenantScenario();

    const unknown = await assign(randomUUID(), {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error.code, 'UTILITY_METER_NOT_FOUND');

    const malformed = await api()
      .post('/api/v1/utility/meters/not-a-uuid/tenant-assignments')
      .set(auth())
      .send({ tenantCompanyId: tenant.id, spaceId: fixture.space.id });
    assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
    assert.equal(malformed.body.error.code, 'VALIDATION_ERROR');

    const unknownAssignment = await api()
      .get(`/api/v1/utility/meter-tenant-assignments/${randomUUID()}`)
      .set(auth());
    assert.equal(unknownAssignment.status, 404);
    assert.equal(
      unknownAssignment.body.error.code,
      'UTILITY_METER_TENANT_ASSIGNMENT_NOT_FOUND',
    );
  });

  it('rejects an invalid tenant or space', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    const unknownTenant = await assign(meter.id, {
      tenantCompanyId: randomUUID(),
      spaceId: fixture.space.id,
    });
    assert.equal(unknownTenant.status, 404, JSON.stringify(unknownTenant.body));
    assert.equal(unknownTenant.body.error.code, 'TENANT_COMPANY_NOT_FOUND');

    const unknownSpace = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: randomUUID(),
    });
    assert.equal(unknownSpace.status, 404, JSON.stringify(unknownSpace.body));
    assert.equal(unknownSpace.body.error.code, 'SPACE_NOT_FOUND');

    const missingFields = await assign(meter.id, {});
    assert.equal(missingFields.status, 400, JSON.stringify(missingFields.body));
    assert.deepEqual(
      missingFields.body.error.details
        .map((detail: { field: string }) => detail.field)
        .sort(),
      ['spaceId', 'tenantCompanyId'],
    );
  });

  it('rejects a space that is not leased by the tenant (BE-14C authority)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    // A real space in the right building, but with no BE-14C tenancy for
    // this tenant — BE-18D must not invent a tenancy BE-14 never recorded.
    const unleasedSpace = await addSpace(fixture);

    const response = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: unleasedSpace.id,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_TENANT_SPACE_MISMATCH',
    );

    // Once BE-14C records the tenancy, the same assignment succeeds.
    await leaseSpace(tenant.id, fixture.building.id, unleasedSpace.id);
    const retried = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: unleasedSpace.id,
    });
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
  });

  it('rejects a space from another building', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    // Another building of the SAME client, with its own space and tenancy.
    const otherBuilding = await buildingService.createBuilding({
      propertyId: fixture.property.id,
      code: `BLDG_${suffix()}`,
      name: 'Other building',
    });
    await buildingAssignmentService.createAssignment(adminUserId, {
      buildingId: otherBuilding.id,
    });
    const otherFloor = await floorService.createFloor({
      buildingId: otherBuilding.id,
      code: `FL_${suffix()}`,
      name: 'Floor',
      levelNumber: 1,
    });
    const otherArea = await areaService.createArea({
      floorId: otherFloor.id,
      code: `AR_${suffix()}`,
      name: 'Area',
    });
    const otherRoom = await roomService.createRoom({
      areaId: otherArea.id,
      code: `RM_${suffix()}`,
      name: 'Room',
    });
    const otherSpace = await spaceService.createSpace({
      roomId: otherRoom.id,
      code: `SP_${suffix()}`,
      name: 'Other unit',
    });
    await leaseSpace(tenant.id, otherBuilding.id, otherSpace.id);

    const response = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: otherSpace.id,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_TENANT_SPACE_MISMATCH',
    );
  });

  it('rejects an inactive meter on an active assignment', async (t) => {
    if (!requireDatabase(t)) return;
    const fixture = await createStructure();
    const inactiveMeter = await createMeter(fixture, { status: 'INACTIVE' });
    const tenant = await createTenantCompany(fixture.client.id);
    await leaseSpace(tenant.id, fixture.building.id, fixture.space.id);

    const response = await assign(inactiveMeter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_TENANT_CONTEXT_UNAVAILABLE',
    );
  });

  it('validates the effective window', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    const inverted = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
      effectiveFrom: '2026-06-01T00:00:00.000Z',
      effectiveUntil: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(inverted.status, 400, JSON.stringify(inverted.body));
    assert.equal(inverted.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      inverted.body.error.details.some(
        (detail: { field: string }) => detail.field === 'effectiveUntil',
      ),
    );

    const malformedDate = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
      effectiveFrom: 'not-a-date',
    });
    assert.equal(malformedDate.status, 400, JSON.stringify(malformedDate.body));
    assert.ok(
      malformedDate.body.error.details.some(
        (detail: { field: string }) => detail.field === 'effectiveFrom',
      ),
    );
  });
});

describe('BE-18D tenant meter — conflicting assignments', () => {
  it('rejects a duplicate or conflicting active assignment for the same meter', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const otherTenant = await createTenantCompany(fixture.client.id);
    const otherSpace = await addSpace(fixture);
    await leaseSpace(otherTenant.id, fixture.building.id, otherSpace.id);

    assert.equal(
      (
        await assign(meter.id, {
          tenantCompanyId: tenant.id,
          spaceId: fixture.space.id,
        })
      ).status,
      201,
    );

    const sameTenant = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(sameTenant.status, 409, JSON.stringify(sameTenant.body));
    assert.equal(
      sameTenant.body.error.code,
      'UTILITY_METER_TENANT_ASSIGNMENT_ALREADY_EXISTS',
    );

    // A different tenant cannot claim a meter that is already assigned.
    const competing = await assign(meter.id, {
      tenantCompanyId: otherTenant.id,
      spaceId: otherSpace.id,
    });
    assert.equal(competing.status, 409, JSON.stringify(competing.body));
    assert.equal(
      competing.body.error.code,
      'UTILITY_METER_TENANT_ASSIGNMENT_ALREADY_EXISTS',
    );
  });

  it('rejects re-activating an assignment while another is active', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const otherTenant = await createTenantCompany(fixture.client.id);
    const otherSpace = await addSpace(fixture);
    await leaseSpace(otherTenant.id, fixture.building.id, otherSpace.id);

    const first = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    const firstId = first.body.data.id;

    await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${firstId}/end`)
      .set(auth())
      .send({});
    assert.equal(
      (
        await assign(meter.id, {
          tenantCompanyId: otherTenant.id,
          spaceId: otherSpace.id,
        })
      ).status,
      201,
    );

    const reactivated = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${firstId}`)
      .set(auth())
      .send({ status: 'ACTIVE' });
    assert.equal(reactivated.status, 409, JSON.stringify(reactivated.body));
    assert.equal(
      reactivated.body.error.code,
      'UTILITY_METER_TENANT_ASSIGNMENT_ALREADY_EXISTS',
    );
  });
});

describe('BE-18D tenant meter — end assignment and history', () => {
  it('ends an assignment, preserves history, and frees the meter', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant, tenancy } = await tenantScenario();
    const nextTenant = await createTenantCompany(fixture.client.id);

    const created = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    const assignmentId = created.body.data.id;

    const ended = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${assignmentId}/end`)
      .set(auth())
      .send({ effectiveUntil: '2026-03-31T00:00:00.000Z' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.equal(ended.body.data.effectiveUntil, '2026-03-31T00:00:00.000Z');

    // The meter no longer resolves to a tenant...
    const resolved = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant`)
      .set(auth());
    assert.equal(resolved.body.data, null);

    // ...but the ended assignment is retained as history, never deleted.
    const history = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth());
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, assignmentId);
    assert.equal(history.body.data[0].status, 'INACTIVE');

    // The unit turns over: BE-14C ends the old tenancy and records the new
    // one, which BE-18D then validates the re-assignment against.
    await endLease(tenancy.id);
    await leaseSpace(nextTenant.id, fixture.building.id, fixture.space.id);

    // Freed, the meter can be re-assigned to the next tenant, and both rows
    // remain — a full tenancy trail for the meter.
    const reassigned = await assign(meter.id, {
      tenantCompanyId: nextTenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(reassigned.status, 201, JSON.stringify(reassigned.body));

    const fullHistory = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth());
    assert.equal(fullHistory.body.data.length, 2);
    assert.equal(
      fullHistory.body.data.filter(
        (entry: { status: string }) => entry.status === 'ACTIVE',
      ).length,
      1,
    );
  });

  it('stamps an end date automatically and rejects immutable field changes', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const created = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    const assignmentId = created.body.data.id;

    const updated = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${assignmentId}`)
      .set(auth())
      .send({ effectiveUntil: '2026-12-31T00:00:00.000Z' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.effectiveUntil, '2026-12-31T00:00:00.000Z');

    const inverted = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${assignmentId}`)
      .set(auth())
      .send({ effectiveUntil: '2025-01-01T00:00:00.000Z' });
    assert.equal(inverted.status, 400, JSON.stringify(inverted.body));
    assert.equal(inverted.body.error.code, 'VALIDATION_ERROR');

    const immutable = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${assignmentId}`)
      .set(auth())
      .send({ tenantCompanyId: randomUUID() });
    assert.equal(immutable.status, 400, JSON.stringify(immutable.body));
    assert.ok(
      immutable.body.error.details.some(
        (detail: { field: string }) => detail.field === 'tenantCompanyId',
      ),
    );

    // Ending without an explicit date closes the window at "now".
    const ended = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${assignmentId}/end`)
      .set(auth())
      .send({});
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.data.status, 'INACTIVE');
    assert.ok(ended.body.data.effectiveUntil !== null);
  });
});

describe('BE-18D tenant meter — client and building isolation', () => {
  it('rejects a tenant company from another client', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter } = await tenantScenario();
    const other = await createStructure();
    const foreignTenant = await createTenantCompany(other.client.id);

    const response = await assign(meter.id, {
      tenantCompanyId: foreignTenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(
      response.body.error.code,
      'UTILITY_METER_TENANT_CLIENT_MISMATCH',
    );
  });

  it('denies access to meters in a building the user is not assigned to', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const created = await assign(meter.id, {
      tenantCompanyId: tenant.id,
      spaceId: fixture.space.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A second administrator with full RBAC but no assignment to this Building.
    const outsider = await createAdminUser();

    const fetched = await api()
      .get(`/api/v1/utility/meter-tenant-assignments/${created.body.data.id}`)
      .set(auth(outsider.token));
    assert.equal(fetched.status, 403, JSON.stringify(fetched.body));
    assert.equal(fetched.body.error.code, 'BUILDING_ACCESS_DENIED');

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 403, JSON.stringify(listed.body));

    const bySpace = await api()
      .get(`/api/v1/spaces/${fixture.space.id}/utility-meters`)
      .set(auth(outsider.token));
    assert.equal(bySpace.status, 403, JSON.stringify(bySpace.body));

    const assigned = await assign(
      meter.id,
      { tenantCompanyId: tenant.id, spaceId: fixture.space.id },
      outsider.token,
    );
    assert.equal(assigned.status, 403, JSON.stringify(assigned.body));

    const ended = await api()
      .patch(
        `/api/v1/utility/meter-tenant-assignments/${created.body.data.id}/end`,
      )
      .set(auth(outsider.token))
      .send({});
    assert.equal(ended.status, 403, JSON.stringify(ended.body));
  });

  it('scopes the tenant listing to buildings the actor can access', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    assert.equal(
      (
        await assign(meter.id, {
          tenantCompanyId: tenant.id,
          spaceId: fixture.space.id,
        })
      ).status,
      201,
    );

    // The outsider can reach the Client (via another building of it) but not
    // the building holding this meter, so the row must not leak.
    const outsider = await createAdminUser();
    const siblingBuilding = await buildingService.createBuilding({
      propertyId: fixture.property.id,
      code: `BLDG_${suffix()}`,
      name: 'Sibling building',
    });
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: siblingBuilding.id,
    });

    const listed = await api()
      .get(`/api/v1/tenant-companies/${tenant.id}/utility-meters`)
      .set(auth(outsider.token));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 0);
  });
});

describe('BE-18D tenant meter — RBAC', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();

    const created = await api()
      .post(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .send({ tenantCompanyId: tenant.id, spaceId: fixture.space.id });
    assert.equal(created.status, 401);

    const listed = await api().get(
      `/api/v1/utility/meters/${meter.id}/tenant-assignments`,
    );
    assert.equal(listed.status, 401);
  });

  it('denies a user without utility_meter permissions (default-deny)', async (t) => {
    if (!requireDatabase(t)) return;
    const { fixture, meter, tenant } = await tenantScenario();
    const plainToken = await createPlainSession();

    const created = await assign(
      meter.id,
      { tenantCompanyId: tenant.id, spaceId: fixture.space.id },
      plainToken,
    );
    assert.equal(created.status, 403, JSON.stringify(created.body));

    const listed = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant-assignments`)
      .set(auth(plainToken));
    assert.equal(listed.status, 403);

    const resolved = await api()
      .get(`/api/v1/utility/meters/${meter.id}/tenant`)
      .set(auth(plainToken));
    assert.equal(resolved.status, 403);

    const byTenant = await api()
      .get(`/api/v1/tenant-companies/${tenant.id}/utility-meters`)
      .set(auth(plainToken));
    assert.equal(byTenant.status, 403);

    const patched = await api()
      .patch(`/api/v1/utility/meter-tenant-assignments/${randomUUID()}`)
      .set(auth(plainToken))
      .send({ status: 'INACTIVE' });
    assert.equal(patched.status, 403);
  });
});
