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
import { purchaseRequestService } from '../src/modules/purchase-requests';
import { functionalLocationService } from '../src/modules/functional-locations';
import { vendorService } from '../src/modules/vendors';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-17C — Service Request focused tests.
 *
 * Covers only Service Request intake: create under a Purchase Request, invalid
 * Purchase Request rejected, invalid Building/location context rejected,
 * required-date validation, update OPEN request, cancel, terminal-state
 * protection, cross-Client / cross-Building isolation, and RBAC. Approval,
 * vendor selection, PO readiness, and operational Work Order execution belong
 * to later BE-17 PARTs / BE-08 and are deliberately not exercised here.
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
    `TRUNCATE service_requests, material_requests, purchase_requests,
            functional_locations, vendors, inventory_items, inventory_warehouses,
            units_of_measure, users, roles, clients, properties, buildings CASCADE`,
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

const suffix = (): string => randomUUID().slice(0, 8).toUpperCase();

async function createBuildingFixture(options?: {
  assignUserId?: string | null;
}) {
  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Test Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Test Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Test Building',
  });

  const assignUserId =
    options?.assignUserId === undefined ? adminUserId : options.assignUserId;
  if (assignUserId) {
    await buildingAssignmentService.createAssignment(assignUserId, {
      buildingId: building.id,
    });
  }

  return { client, property, building };
}

async function createPurchaseRequestVia(
  buildingId: string,
  clientId: string,
): Promise<{ id: string; buildingId: string; clientId: string }> {
  const pr = await purchaseRequestService.createPurchaseRequest({
    clientId,
    buildingId,
    requestNumber: `PRQ_${suffix()}`,
    requestType: 'SERVICE',
    title: 'Test Purchase Request',
    requestedByUserId: adminUserId,
  });
  return { id: pr.id, buildingId: pr.buildingId, clientId: pr.clientId };
}

async function createLocationVia(
  buildingId: string,
): Promise<{ id: string; buildingId: string }> {
  const location = await functionalLocationService.createFunctionalLocation({
    buildingId,
    code: `FL_${suffix()}`,
    name: 'Test Location',
  });
  return { id: location.id, buildingId: location.buildingId };
}

async function createVendorVia(
  clientId: string,
): Promise<{ id: string; clientId: string }> {
  const vendor = await vendorService.createVendor({
    clientId,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Test Vendor',
  });
  return { id: vendor.id, clientId: vendor.clientId };
}

async function createServiceRequestVia(
  purchaseRequestId: string,
  body: Record<string, unknown>,
) {
  return api()
    .post(`/api/v1/purchase-requests/${purchaseRequestId}/service-requests`)
    .set(authHeaders())
    .send(body);
}

const PUBLIC_SERVICE_REQUEST_KEYS = [
  'buildingId',
  'clientId',
  'createdAt',
  'description',
  'functionalLocation',
  'functionalLocationId',
  'id',
  'notes',
  'purchaseRequest',
  'purchaseRequestId',
  'requiredDate',
  'requestedByUserId',
  'serviceCatalogId',
  'serviceType',
  'status',
  'title',
  'updatedAt',
  'vendorId',
];

describe('create service request', () => {
  it('registers a service request under a purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'HVAC repair',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(
      Object.keys(response.body.data).sort(),
      [...PUBLIC_SERVICE_REQUEST_KEYS].sort(),
    );
    assert.equal(response.body.data.purchaseRequestId, pr.id);
    assert.equal(response.body.data.serviceType, 'REPAIR');
    assert.equal(response.body.data.title, 'HVAC repair');
    assert.equal(response.body.data.status, 'OPEN');
    assert.equal(response.body.data.buildingId, building.id);
    assert.equal(response.body.data.clientId, client.id);
    assert.equal(response.body.data.requestedByUserId, adminUserId);
    assert.equal(response.body.data.notes, null);
    assert.equal(response.body.data.requiredDate, null);
  });

  it('captures description, required date, location, vendor, and notes', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const location = await createLocationVia(building.id);
    const vendor = await createVendorVia(client.id);
    const requiredDate = '2026-09-25T00:00:00.000Z';

    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'CLEANING',
      title: 'Deep cleaning',
      description: 'Deep clean the lobby area.',
      requiredDate,
      functionalLocationId: location.id,
      vendorId: vendor.id,
      notes: 'Coordinate with front desk.',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.description, 'Deep clean the lobby area.');
    assert.equal(response.body.data.requiredDate, requiredDate);
    assert.equal(response.body.data.functionalLocationId, location.id);
    assert.equal(response.body.data.vendorId, vendor.id);
    assert.equal(response.body.data.notes, 'Coordinate with front desk.');
  });

  it('normalizes the service type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createServiceRequestVia(pr.id, {
      serviceType: '  maintenance  ',
      title: 'Maintenance service',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.serviceType, 'MAINTENANCE');
  });

  it('rejects an unknown purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await createServiceRequestVia(randomUUID(), {
      serviceType: 'REPAIR',
      title: 'Orphan service',
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'PURCHASE_REQUEST_NOT_FOUND');
  });

  it('rejects adding a service request to a cancelled purchase request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    await api()
      .post(`/api/v1/purchase-requests/${pr.id}/cancel`)
      .set(authHeaders());

    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'On cancelled PR',
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SERVICE_REQUEST_PURCHASE_REQUEST_NOT_OPEN',
    );
  });

  it('rejects an invalid service type', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'lower case!!',
      title: 'Bad type',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an invalid required date', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Bad date',
      requiredDate: 'not-a-date',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an unknown functional location', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Bad location',
      functionalLocationId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'FUNCTIONAL_LOCATION_NOT_FOUND');
  });

  it('rejects a functional location from a different building', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const { building: building2 } = await createBuildingFixture();
    const locationB = await createLocationVia(building2.id);

    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Cross-building location',
      functionalLocationId: locationB.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SERVICE_REQUEST_LOCATION_BUILDING_MISMATCH',
    );
  });

  it('rejects a vendor from a different client', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const { client: foreignClient, building: foreignBuilding } =
      await createBuildingFixture();
    const foreignVendor = await createVendorVia(foreignClient.id);

    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Cross-client vendor',
      vendorId: foreignVendor.id,
    });
    assert.equal(response.status, 400);
    assert.equal(
      response.body.error.code,
      'SERVICE_REQUEST_VENDOR_CLIENT_MISMATCH',
    );
    void foreignBuilding;
  });

  it('rejects an unknown vendor', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const response = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Bad vendor',
      vendorId: randomUUID(),
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'VENDOR_NOT_FOUND');
  });
});

describe('get service request', () => {
  it('returns a service request by id with resolved context', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const location = await createLocationVia(building.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Lift repair',
      functionalLocationId: location.id,
    });
    assert.equal(created.status, 201);

    const response = await api()
      .get(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.body.data.id);
    assert.equal(response.body.data.serviceType, 'REPAIR');
    assert.equal(response.body.data.purchaseRequest.id, pr.id);
    assert.equal(response.body.data.functionalLocation.id, location.id);
  });

  it('returns 404 for an unknown service request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/service-requests/${randomUUID()}`)
      .set(authHeaders());
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'SERVICE_REQUEST_NOT_FOUND');
  });
});

describe('list / filter service requests', () => {
  it('lists by purchase request and by building with filters', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    await createServiceRequestVia(pr.id, { serviceType: 'REPAIR', title: 'A' });
    await createServiceRequestVia(pr.id, { serviceType: 'REPAIR', title: 'B' });
    await createServiceRequestVia(pr.id, { serviceType: 'CLEANING', title: 'C' });

    const byPr = await api()
      .get(`/api/v1/purchase-requests/${pr.id}/service-requests`)
      .set(authHeaders());
    assert.equal(byPr.status, 200);
    assert.equal(byPr.body.data.length, 3);

    const byBuilding = await api()
      .get(`/api/v1/buildings/${building.id}/service-requests`)
      .set(authHeaders());
    assert.equal(byBuilding.status, 200);
    assert.equal(byBuilding.body.data.length, 3);

    const repair = await api()
      .get(`/api/v1/buildings/${building.id}/service-requests?serviceType=REPAIR`)
      .set(authHeaders());
    assert.equal(repair.status, 200);
    assert.equal(repair.body.data.length, 2);

    const open = await api()
      .get(`/api/v1/buildings/${building.id}/service-requests?status=OPEN`)
      .set(authHeaders());
    assert.equal(open.status, 200);
    assert.equal(open.body.data.length, 3);
  });

  it('returns 403 for an unknown building on the building list', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const response = await api()
      .get(`/api/v1/buildings/${randomUUID()}/service-requests`)
      .set(authHeaders());
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUILDING_ACCESS_DENIED');
  });
});

describe('update open service request', () => {
  it('updates fields while OPEN', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const location = await createLocationVia(building.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Original title',
    });
    assert.equal(created.status, 201);

    const requiredDate = '2026-12-01T00:00:00.000Z';
    const response = await api()
      .patch(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({
        serviceType: 'MAINTENANCE',
        title: 'Updated title',
        description: 'Updated notes',
        requiredDate,
        functionalLocationId: location.id,
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.serviceType, 'MAINTENANCE');
    assert.equal(response.body.data.title, 'Updated title');
    assert.equal(response.body.data.description, 'Updated notes');
    assert.equal(response.body.data.requiredDate, requiredDate);
    assert.equal(response.body.data.functionalLocationId, location.id);
  });

  it('clears optional fields with explicit null', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const location = await createLocationVia(building.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Clear me',
      description: 'Some note',
      requiredDate: '2026-12-01T00:00:00.000Z',
      functionalLocationId: location.id,
    });
    assert.equal(created.status, 201);

    const response = await api()
      .patch(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ description: null, requiredDate: null, functionalLocationId: null });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.description, null);
    assert.equal(response.body.data.requiredDate, null);
    assert.equal(response.body.data.functionalLocationId, null);
  });

  it('rejects an invalid update body', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Bad update',
    });

    const response = await api()
      .patch(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ serviceType: 'invalid type!!' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

describe('cancel service request', () => {
  it('cancels an open service request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Cancel me',
    });
    assert.equal(created.status, 201);

    const response = await api()
      .post(`/api/v1/service-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'CANCELLED');
  });
});

describe('terminal-state protection', () => {
  it('cannot update a cancelled service request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Cancel then update',
    });
    await api()
      .post(`/api/v1/service-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const response = await api()
      .patch(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders())
      .send({ title: 'Should fail' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'SERVICE_REQUEST_NOT_OPEN');
  });

  it('cannot cancel an already-cancelled service request', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Cancel twice',
    });
    await api()
      .post(`/api/v1/service-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());

    const second = await api()
      .post(`/api/v1/service-requests/${created.body.data.id}/cancel`)
      .set(authHeaders());
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'SERVICE_REQUEST_NOT_OPEN');
  });
});

describe('RBAC and isolation', () => {
  it('requires authentication', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture();
    const response = await api().get(
      `/api/v1/buildings/${building.id}/service-requests`,
    );
    assert.equal(response.status, 401);
  });

  it('denies a user without service request permissions', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const plainToken = await createPlainSession();
    const { building } = await createBuildingFixture();

    const read = await api()
      .get(`/api/v1/buildings/${building.id}/service-requests`)
      .set(authHeaders(plainToken));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'PERMISSION_DENIED');
  });

  it('denies building-nested routes without a building assignment', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building } = await createBuildingFixture({ assignUserId: null });
    const list = await api()
      .get(`/api/v1/buildings/${building.id}/service-requests`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies service-request routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { client, building } = await createBuildingFixture();
    const pr = await createPurchaseRequestVia(building.id, client.id);
    const created = await createServiceRequestVia(pr.id, {
      serviceType: 'REPAIR',
      title: 'Isolated',
    });
    assert.equal(created.status, 201);

    const outsider = await createAdminUser();

    const read = await api()
      .get(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token));
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const write = await api()
      .patch(`/api/v1/service-requests/${created.body.data.id}`)
      .set(authHeaders(outsider.token))
      .send({ title: 'Hijacked' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'BUILDING_ACCESS_DENIED');
  });

  it('denies purchase-request-nested routes across the isolation boundary', async (t) => {
    if (!requireDatabase(t)) {
      return;
    }

    const { building: buildingA } = await createBuildingFixture();

    const ownerB = await createAdminUser();
    const { building: buildingB, client: clientB } = await createBuildingFixture({
      assignUserId: ownerB.userId,
    });
    const prB = await createPurchaseRequestVia(buildingB.id, clientB.id);
    const createdB = await api()
      .post(`/api/v1/purchase-requests/${prB.id}/service-requests`)
      .set(authHeaders(ownerB.token))
      .send({ serviceType: 'REPAIR', title: 'In building B' });
    assert.equal(createdB.status, 201);

    const read = await api()
      .get(`/api/v1/service-requests/${createdB.body.data.id}`)
      .set(authHeaders());
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'BUILDING_ACCESS_DENIED');

    const list = await api()
      .get(`/api/v1/purchase-requests/${prB.id}/service-requests`)
      .set(authHeaders());
    assert.equal(list.status, 403);
    assert.equal(list.body.error.code, 'BUILDING_ACCESS_DENIED');
    void buildingA;
  });
});
