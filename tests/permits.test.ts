import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { areaService } from '../src/modules/areas';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService, type PublicClient } from '../src/modules/clients';
import { floorService } from '../src/modules/floors';
import { parseCreatePermitBody } from '../src/modules/permits';
import { propertyService } from '../src/modules/properties';
import { roomService } from '../src/modules/rooms';
import { spaceService } from '../src/modules/spaces';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantContractorService } from '../src/modules/tenant-contractors';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { vendorBuildingService } from '../src/modules/vendor-buildings';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let token = '';
let userId = '';
const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (value = token) => ({ Authorization: `Bearer ${value}` });

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE permits, operational_events,
    tenant_contractor_relationships, tenant_building_contexts,
    tenant_space_relationships, tenant_companies,
    vendor_building_relationships, vendors, spaces, rooms, areas, floors,
    buildings, properties, users, roles, permissions, clients CASCADE`);
  const manager = await createAdminUser();
  token = manager.token;
  userId = manager.userId;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

async function structure(options: {
  client?: PublicClient;
  assignUserId?: string;
  withSpace?: boolean;
} = {}) {
  const client = options.client ?? await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Owner Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(
    options.assignUserId ?? userId,
    { buildingId: building.id },
  );

  if (!options.withSpace) return { client, building, space: null };
  const floor = await floorService.createFloor({
    buildingId: building.id,
    code: `F_${suffix()}`,
    name: 'Floor',
    levelNumber: 1,
  });
  const area = await areaService.createArea({
    floorId: floor.id,
    code: `A_${suffix()}`,
    name: 'Area',
  });
  const room = await roomService.createRoom({
    areaId: area.id,
    code: `R_${suffix()}`,
    name: 'Room',
  });
  const space = await spaceService.createSpace({
    roomId: room.id,
    code: `S_${suffix()}`,
    name: 'Tenant Space',
  });
  return { client, building, space };
}

async function vendorContext(options: {
  assignUserId?: string;
} = {}) {
  const context = await structure(options);
  const vendor = await vendorService.createVendor({
    clientId: context.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Contractor Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: context.building.id,
  });
  return { ...context, vendor };
}

async function tenantContractorContext() {
  const context = await structure({ withSpace: true });
  assert.ok(context.space);
  const company = await tenantCompanyService.createTenantCompany({
    clientId: context.client.id,
    tenantCode: `T_${suffix()}`,
    tenantName: 'Tenant Company',
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: company.id,
    buildingId: context.building.id,
    spaceId: context.space.id,
  }, userId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: company.id,
    buildingId: context.building.id,
  }, userId);
  const vendor = await vendorService.createVendor({
    clientId: context.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Tenant Contractor Vendor',
  });
  await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: context.building.id,
  });
  const relationship =
    await tenantContractorService.createTenantContractorRelationship({
      tenantCompanyId: company.id,
      contractorVendorId: vendor.id,
      buildingId: context.building.id,
      spaceId: context.space.id,
      relationshipType: 'MAINTENANCE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    }, userId);
  return { ...context, company, vendor, relationship };
}

function permitBody(
  buildingId: string,
  contractorContextId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    buildingId,
    permitNumber: `PTW-${suffix()}`,
    permitType: 'HOT_WORK',
    title: 'Welding repair',
    workDescription: 'Repair the damaged steel support by welding.',
    applicantReference: 'APPLICANT-001',
    contractorContextType: 'VENDOR_CONTRACTOR',
    contractorContextId,
    ...extra,
  };
}

async function createPermit(body: object, withToken = token) {
  return api().post('/api/v1/permits').set(auth(withToken)).send(body);
}

describe('BE-20A Permit Foundation', () => {
  it('normalizes the Permit number, type, and contractor context', () => {
    const parsed = parseCreatePermitBody({
      buildingId: randomUUID(),
      permitNumber: ' ptw-001 ',
      permitType: ' hot_work ',
      title: ' Test permit ',
      workDescription: ' Controlled work ',
      contractorContextType: ' vendor_contractor ',
      contractorContextId: randomUUID(),
    });
    assert.equal(parsed.permitNumber, 'PTW-001');
    assert.equal(parsed.permitType, 'HOT_WORK');
    assert.equal(parsed.contractorContextType, 'VENDOR_CONTRACTOR');
  });

  it('creates, gets, and filters a valid Vendor Contractor Permit', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const created = await createPermit(
      permitBody(fixture.building.id, fixture.vendor.id),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.clientId, fixture.client.id);
    assert.equal(created.body.data.contractorVendorId, fixture.vendor.id);
    assert.equal(created.body.data.contractorContextId, fixture.vendor.id);
    assert.equal(created.body.data.status, 'DRAFT');
    assert.ok(created.body.data.requestedAt);

    const fetched = await api()
      .get(`/api/v1/permits/${created.body.data.id}`)
      .set(auth());
    assert.equal(fetched.status, 200);

    const listed = await api()
      .get('/api/v1/permits')
      .query({
        buildingId: fixture.building.id,
        contractorId: fixture.vendor.id,
        status: 'DRAFT',
        permitType: 'HOT_WORK',
      })
      .set(auth());
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].id, created.body.data.id);
  });

  it('creates a Permit from an existing Tenant Contractor context', async (t) => {
    if (!ready(t)) return;
    const fixture = await tenantContractorContext();
    const created = await createPermit(permitBody(
      fixture.building.id,
      fixture.relationship.id,
      { contractorContextType: 'TENANT_CONTRACTOR' },
    ));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.contractorContextType, 'TENANT_CONTRACTOR');
    assert.equal(created.body.data.contractorContextId, fixture.relationship.id);
    assert.equal(created.body.data.tenantContractorRelationshipId, fixture.relationship.id);
    assert.equal(created.body.data.contractorVendorId, fixture.vendor.id);
  });

  it('rejects invalid Vendor and Tenant Contractor references', async (t) => {
    if (!ready(t)) return;
    const fixture = await structure();
    const invalidVendor = await createPermit(
      permitBody(fixture.building.id, randomUUID()),
    );
    assert.equal(invalidVendor.status, 400);
    assert.equal(invalidVendor.body.error.code, 'PERMIT_CONTRACTOR_INVALID');

    const invalidTenant = await createPermit(permitBody(
      fixture.building.id,
      randomUUID(),
      { contractorContextType: 'TENANT_CONTRACTOR' },
    ));
    assert.equal(invalidTenant.status, 400);
    assert.equal(invalidTenant.body.error.code, 'PERMIT_CONTRACTOR_INVALID');
  });

  it('rejects duplicate Permit numbers within one Client', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const body = permitBody(fixture.building.id, fixture.vendor.id);
    assert.equal((await createPermit(body)).status, 201);
    const duplicate = await createPermit(body);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'PERMIT_NUMBER_ALREADY_EXISTS');
  });

  it('rejects a contractor that does not serve the Permit Building', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const other = await structure({ client: fixture.client });
    const mismatch = await createPermit(
      permitBody(other.building.id, fixture.vendor.id),
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'PERMIT_CONTEXT_MISMATCH');
  });

  it('updates basic DRAFT metadata and then cancels the Permit', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const created = await createPermit(
      permitBody(fixture.building.id, fixture.vendor.id),
    );
    const id = created.body.data.id;
    const updated = await api()
      .patch(`/api/v1/permits/${id}`)
      .set(auth())
      .send({
        permitType: 'COLD_WORK',
        title: 'Updated work',
        workDescription: 'Updated controlled work description.',
        applicantReference: null,
      });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.data.permitType, 'COLD_WORK');
    assert.equal(updated.body.data.applicantReference, null);

    const cancelled = await api()
      .post(`/api/v1/permits/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    assert.ok(cancelled.body.data.cancelledAt);

    const protectedUpdate = await api()
      .patch(`/api/v1/permits/${id}`)
      .set(auth())
      .send({ title: 'Forbidden change' });
    assert.equal(protectedUpdate.status, 400);
    assert.equal(protectedUpdate.body.error.code, 'PERMIT_UPDATE_NOT_ALLOWED');
    const secondCancel = await api()
      .post(`/api/v1/permits/${id}/cancel`)
      .set(auth())
      .send({});
    assert.equal(secondCancel.status, 400);
    assert.equal(secondCancel.body.error.code, 'PERMIT_CANCEL_NOT_ALLOWED');
  });

  it('enforces Permit RBAC', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const plainToken = await createPlainSession();
    const deniedCreate = await createPermit(
      permitBody(fixture.building.id, fixture.vendor.id),
      plainToken,
    );
    assert.equal(deniedCreate.status, 403);
    assert.equal(deniedCreate.body.error.code, 'PERMISSION_DENIED');

    const created = await createPermit(
      permitBody(fixture.building.id, fixture.vendor.id),
    );
    const deniedRead = await api()
      .get(`/api/v1/permits/${created.body.data.id}`)
      .set(auth(plainToken));
    assert.equal(deniedRead.status, 403);
    assert.equal(deniedRead.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation for get and list', async (t) => {
    if (!ready(t)) return;
    const owner = await vendorContext();
    const created = await createPermit(
      permitBody(owner.building.id, owner.vendor.id),
    );
    const otherManager = await createAdminUser();
    await structure({ assignUserId: otherManager.userId });

    const denied = await api()
      .get(`/api/v1/permits/${created.body.data.id}`)
      .set(auth(otherManager.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get('/api/v1/permits')
      .set(auth(otherManager.token));
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((permit: { id: string }) =>
        permit.id === created.body.data.id),
      false,
    );
  });
});
