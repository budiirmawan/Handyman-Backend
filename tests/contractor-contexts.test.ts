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

async function vendorContext(options: { assignUserId?: string } = {}) {
  const context = await structure(options);
  const vendor = await vendorService.createVendor({
    clientId: context.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Vendor Contractor',
  });
  const relationship = await vendorBuildingService.assignBuildingToVendor({
    vendorId: vendor.id,
    buildingId: context.building.id,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  });
  return { ...context, vendor, vendorBuildingRelationship: relationship };
}

async function tenantContext() {
  const context = await structure({ withSpace: true });
  assert.ok(context.space);
  const tenant = await tenantCompanyService.createTenantCompany({
    clientId: context.client.id,
    tenantCode: `T_${suffix()}`,
    tenantName: 'Tenant Company',
  }, userId);
  await tenantSpaceService.assignSpaceToTenant({
    tenantCompanyId: tenant.id,
    buildingId: context.building.id,
    spaceId: context.space.id,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  }, userId);
  await tenantBuildingContextService.createTenantBuildingContext({
    tenantCompanyId: tenant.id,
    buildingId: context.building.id,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  }, userId);
  const vendor = await vendorService.createVendor({
    clientId: context.client.id,
    vendorCode: `V_${suffix()}`,
    vendorName: 'Tenant Contractor Vendor',
  });
  const vendorBuildingRelationship =
    await vendorBuildingService.assignBuildingToVendor({
      vendorId: vendor.id,
      buildingId: context.building.id,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    });
  const relationship =
    await tenantContractorService.createTenantContractorRelationship({
      tenantCompanyId: tenant.id,
      contractorVendorId: vendor.id,
      buildingId: context.building.id,
      spaceId: context.space.id,
      relationshipType: 'MAINTENANCE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    }, userId);
  return {
    ...context,
    tenant,
    vendor,
    vendorBuildingRelationship,
    relationship,
  };
}

function reference(
  contractorContextType: 'TENANT_CONTRACTOR' | 'VENDOR_CONTRACTOR',
  contractorContextId: string,
  buildingId?: string,
) {
  return {
    contractorContextType,
    contractorContextId,
    ...(buildingId ? { buildingId } : {}),
  };
}

async function resolve(body: object, withToken = token) {
  return api()
    .post('/api/v1/contractor-contexts/resolve')
    .set(auth(withToken))
    .send(body);
}

describe('BE-20B Contractor Context', () => {
  it('resolves and gets a valid Tenant Contractor', async (t) => {
    if (!ready(t)) return;
    const fixture = await tenantContext();
    const resolved = await resolve(reference(
      'TENANT_CONTRACTOR',
      fixture.relationship.id,
      fixture.building.id,
    ));
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.contractorContextType, 'TENANT_CONTRACTOR');
    assert.equal(resolved.body.data.contractorContextId, fixture.relationship.id);
    assert.equal(resolved.body.data.vendorId, fixture.vendor.id);
    assert.equal(resolved.body.data.tenantCompanyId, fixture.tenant.id);
    assert.equal(resolved.body.data.relationshipType, 'MAINTENANCE');
    assert.equal(resolved.body.data.eligibleForPermit, true);

    const fetched = await api()
      .get(`/api/v1/contractor-contexts/TENANT_CONTRACTOR/${fixture.relationship.id}`)
      .set(auth());
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
    assert.equal(fetched.body.data.vendorName, fixture.vendor.vendorName);
  });

  it('resolves and validates a valid Vendor Contractor', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const resolved = await resolve(reference(
      'VENDOR_CONTRACTOR',
      fixture.vendor.id,
      fixture.building.id,
    ));
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.contractorContextType, 'VENDOR_CONTRACTOR');
    assert.equal(resolved.body.data.contractorContextId, fixture.vendor.id);
    assert.equal(resolved.body.data.tenantCompanyId, null);
    assert.equal(
      resolved.body.data.vendorBuildingRelationshipId,
      fixture.vendorBuildingRelationship.id,
    );

    const eligibility = await api()
      .post('/api/v1/contractor-contexts/permit-eligibility')
      .set(auth())
      .send(reference(
        'VENDOR_CONTRACTOR',
        fixture.vendor.id,
        fixture.building.id,
      ));
    assert.equal(eligibility.status, 200, JSON.stringify(eligibility.body));
    assert.equal(eligibility.body.data.eligible, true);
    assert.equal(eligibility.body.data.contractorContext.vendorId, fixture.vendor.id);
  });

  it('rejects invalid Tenant and Vendor Contractor references', async (t) => {
    if (!ready(t)) return;
    const context = await structure();
    for (const source of ['TENANT_CONTRACTOR', 'VENDOR_CONTRACTOR'] as const) {
      const response = await resolve(reference(
        source,
        randomUUID(),
        context.building.id,
      ));
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'CONTRACTOR_CONTEXT_INVALID');
    }
  });

  it('rejects inactive Tenant and Vendor relationships', async (t) => {
    if (!ready(t)) return;
    const tenant = await tenantContext();
    await tenantContractorService.updateTenantContractorRelationship(
      tenant.relationship.id,
      { status: 'INACTIVE' },
      userId,
    );
    const inactiveTenant = await resolve(reference(
      'TENANT_CONTRACTOR',
      tenant.relationship.id,
      tenant.building.id,
    ));
    assert.equal(inactiveTenant.status, 400);
    assert.equal(inactiveTenant.body.error.code, 'CONTRACTOR_CONTEXT_INACTIVE');

    const vendor = await vendorContext();
    await vendorBuildingService.updateVendorBuildingRelationship(
      vendor.vendor.id,
      vendor.building.id,
      { status: 'INACTIVE' },
    );
    const inactiveVendor = await resolve(reference(
      'VENDOR_CONTRACTOR',
      vendor.vendor.id,
      vendor.building.id,
    ));
    assert.equal(inactiveVendor.status, 400);
    assert.equal(inactiveVendor.body.error.code, 'CONTRACTOR_CONTEXT_INACTIVE');
  });

  it('preserves source/type and filters by Tenant, Vendor, and Building', async (t) => {
    if (!ready(t)) return;
    const tenant = await tenantContext();
    const vendor = await vendorContext();

    const tenantList = await api()
      .get('/api/v1/contractor-contexts')
      .query({
        sourceType: 'TENANT_CONTRACTOR',
        tenantCompanyId: tenant.tenant.id,
        vendorId: tenant.vendor.id,
        buildingId: tenant.building.id,
      })
      .set(auth());
    assert.equal(tenantList.status, 200, JSON.stringify(tenantList.body));
    assert.equal(tenantList.body.data.length, 1);
    assert.equal(
      tenantList.body.data[0].contractorContextType,
      'TENANT_CONTRACTOR',
    );

    const vendorList = await api()
      .get('/api/v1/contractor-contexts')
      .query({
        contractorContextType: 'VENDOR_CONTRACTOR',
        vendorId: vendor.vendor.id,
        buildingId: vendor.building.id,
      })
      .set(auth());
    assert.equal(vendorList.status, 200, JSON.stringify(vendorList.body));
    assert.equal(vendorList.body.data.length, 1);
    assert.equal(
      vendorList.body.data[0].contractorContextType,
      'VENDOR_CONTRACTOR',
    );
  });

  it('rejects a Contractor/Building mismatch', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const other = await structure({ client: fixture.client });
    const mismatch = await resolve(reference(
      'VENDOR_CONTRACTOR',
      fixture.vendor.id,
      other.building.id,
    ));
    assert.equal(mismatch.status, 400);
    assert.equal(
      mismatch.body.error.code,
      'CONTRACTOR_CONTEXT_BUILDING_MISMATCH',
    );
  });

  it('enforces Permit RBAC for Contractor resolution and listing', async (t) => {
    if (!ready(t)) return;
    const fixture = await vendorContext();
    const plainToken = await createPlainSession();
    const deniedResolve = await resolve(reference(
      'VENDOR_CONTRACTOR',
      fixture.vendor.id,
      fixture.building.id,
    ), plainToken);
    assert.equal(deniedResolve.status, 403);
    assert.equal(deniedResolve.body.error.code, 'PERMISSION_DENIED');

    const deniedList = await api()
      .get('/api/v1/contractor-contexts')
      .set(auth(plainToken));
    assert.equal(deniedList.status, 403);
    assert.equal(deniedList.body.error.code, 'PERMISSION_DENIED');
  });

  it('enforces Client and Building isolation', async (t) => {
    if (!ready(t)) return;
    const owner = await vendorContext();
    const otherManager = await createAdminUser();
    await structure({ assignUserId: otherManager.userId });

    const denied = await resolve(reference(
      'VENDOR_CONTRACTOR',
      owner.vendor.id,
      owner.building.id,
    ), otherManager.token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get('/api/v1/contractor-contexts')
      .set(auth(otherManager.token));
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((context: { vendorId: string }) =>
        context.vendorId === owner.vendor.id),
      false,
    );
  });
});
